// The gate in front of every extraction call (security review B1): today's budget, the new-sender sub-cap, and the
// stricter prefilter for a never-seen sender. Used by the direct path and by the batch submit, so one rule covers both.
//
// Order, cheapest first (so a capped message costs no provider read):
//   1 daily cap reached            -> stop; the rest of the run stays `discovered`
//   2 new sender and sub-cap hit   -> leave this message `discovered`, go on with known senders
//   3 (after the read) new sender whose subject does not reach the stricter score -> `prefiltered_out`
// A message that passes is charged (`markCharged`) before it is sent.
import { prefilter } from "@mp/email/prefilter";
import { isSameOrSubdomain } from "@mp/email";
import type { Tx, WorkerDb } from "@mp/db";
import {
  budgetOf,
  loadBudget,
  markCharged,
  type Budget,
  type ExtractLimits,
  type TakeResult,
} from "./limits";
import * as repo from "./repo";

export interface Gate {
  limits: ExtractLimits;
  budget: Budget;
  watched: readonly string[];
  timezone: string;
}

export async function loadGate(
  tx: Tx,
  householdId: string,
  timezone: string,
  nowIso: string,
  limits: ExtractLimits,
  excludeBatchId: string | null = null,
): Promise<Gate> {
  return {
    limits,
    budget: await loadBudget(tx, householdId, timezone, nowIso, limits, excludeBatchId),
    watched: await repo.watchedDomains(tx, householdId),
    timezone,
  };
}

/** A gate that charges nothing (a batch that was charged when it was submitted). */
export const openGate = (limits: ExtractLimits, timezone: string): Gate => ({
  limits,
  budget: budgetOf(limits, 0, 0),
  watched: [],
  timezone,
});

/**
 * Is the sender new to the household? Not new when the household watches its domain (an item's provider domain or a
 * `watch` rule) or a person has already decided an item from it (Q-235).
 */
export async function isNewSender(
  db: WorkerDb,
  householdId: string,
  gate: Gate,
  fromDomain: string,
): Promise<boolean> {
  if (gate.watched.some((d) => isSameOrSubdomain(fromDomain, d))) return false;
  return db.withJobTx(householdId, (tx) => repo.senderFirstSeen(tx, householdId, fromDomain));
}

/** Would a call be allowed right now? Spends nothing (used before the message is even read). */
export function peek(gate: Gate, newSender: boolean): TakeResult {
  return gate.budget.peek(newSender);
}

/** Charges one call against the gate. Nothing is spent unless it says `ok`. */
export function take(gate: Gate, newSender: boolean): TakeResult {
  return gate.budget.take(newSender);
}

/** The stricter bar a never-seen sender must clear before its message is sent to the model (metadata only). */
export function clearsNewSenderBar(subject: string, fromDomain: string, limits: ExtractLimits): boolean {
  return (
    prefilter(
      { from: `billing@${fromDomain}`, subject, labels: [], listId: null },
      { watchedDomains: [], ignoredDomains: [], threshold: limits.newSenderMinScore },
    ).decision === "continue"
  );
}

export async function charge(
  db: WorkerDb,
  householdId: string,
  messageId: string,
  newSender: boolean,
  nowIso: string,
): Promise<void> {
  await db.withJobTx(householdId, (tx) => markCharged(tx, householdId, messageId, newSender, nowIso));
}
