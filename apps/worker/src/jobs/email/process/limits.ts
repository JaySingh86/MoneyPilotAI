// Cost caps for the extraction step (security review B1). Every model call costs money and a mailbox is an unbounded
// source of messages (a spammer, a flood, a bug), so extraction is metered per household per local day, with a smaller
// sub-cap for senders the household has never had a decided item from, a total cap on the 13-month backfill, and a
// stricter bar before a never-seen sender's message is sent to the model at all. A message over a cap is left in
// `discovered` (it is tried again after midnight local time); nothing is dropped and nothing is logged but counts.
import { Temporal } from "@js-temporal/polyfill";
import { sql } from "drizzle-orm";
import type { Tx } from "@mp/db";

export interface ExtractLimits {
  /** Extraction calls per household per household-local day (`AI_EXTRACT_DAILY_CAP_PER_HOUSEHOLD`). */
  dailyPerHousehold: number;
  /** Of those, calls for senders never seen before (`AI_EXTRACT_DAILY_CAP_NEW_SENDERS`). */
  dailyNewSenders: number;
  /** Messages one connection's backfill may send to the model in total (`AI_BACKFILL_MAX_MESSAGES`). */
  backfillMax: number;
  /** Keyword score a never-seen sender's subject must reach (`EMAIL_NEW_SENDER_MIN_SCORE`; prefilter default is 3). */
  newSenderMinScore: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  dailyPerHousehold: 100,
  dailyNewSenders: 20,
  backfillMax: 500,
  newSenderMinScore: 5,
};

export interface LimitsEnv {
  AI_EXTRACT_DAILY_CAP_PER_HOUSEHOLD?: string | undefined;
  AI_EXTRACT_DAILY_CAP_NEW_SENDERS?: string | undefined;
  AI_BACKFILL_MAX_MESSAGES?: string | undefined;
  EMAIL_NEW_SENDER_MIN_SCORE?: string | undefined;
}

const whole = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Unset or invalid values fall back to the defaults (a typo never lifts a cap). */
export function limitsFromEnv(env: LimitsEnv): ExtractLimits {
  return {
    dailyPerHousehold: whole(
      env.AI_EXTRACT_DAILY_CAP_PER_HOUSEHOLD,
      DEFAULT_LIMITS.dailyPerHousehold,
      0,
      100_000,
    ),
    dailyNewSenders: whole(env.AI_EXTRACT_DAILY_CAP_NEW_SENDERS, DEFAULT_LIMITS.dailyNewSenders, 0, 100_000),
    backfillMax: whole(env.AI_BACKFILL_MAX_MESSAGES, DEFAULT_LIMITS.backfillMax, 0, 100_000),
    newSenderMinScore: whole(env.EMAIL_NEW_SENDER_MIN_SCORE, DEFAULT_LIMITS.newSenderMinScore, 0, 100),
  };
}

export type TakeResult = "ok" | "daily_cap" | "new_sender_cap";

/** What is left of today's budget. `take` spends one call; nothing is spent when it says no. */
export interface Budget {
  /** Would a call be allowed? Spends nothing. */
  peek(newSender: boolean): TakeResult;
  take(newSender: boolean): TakeResult;
  readonly used: number;
  readonly newUsed: number;
}

export function budgetOf(limits: ExtractLimits, used: number, newUsed: number): Budget {
  let u = used;
  let n = newUsed;
  const peek = (newSender: boolean): TakeResult => {
    if (u >= limits.dailyPerHousehold) return "daily_cap";
    if (newSender && n >= limits.dailyNewSenders) return "new_sender_cap";
    return "ok";
  };
  return {
    peek,
    take(newSender) {
      const verdict = peek(newSender);
      if (verdict !== "ok") return verdict;
      u++;
      if (newSender) n++;
      return "ok";
    },
    get used() {
      return u;
    },
    get newUsed() {
      return n;
    },
  };
}

/** The UTC instant the household's local day began. */
export function localDayStart(nowIso: string, timezone: string): string {
  return Temporal.Instant.from(nowIso)
    .toZonedDateTimeISO(timezone)
    .startOfDay()
    .toInstant()
    .toString({ smallestUnit: "second" });
}

/**
 * Today's spend for a household: the extraction runs already metered (`ai_runs`, purpose `extract`) plus messages
 * reserved for a batch that has no results yet (their runs are metered when the batch is collected), and, for the
 * new-sender sub-cap, the messages charged today as a never-seen sender.
 */
export async function loadBudget(
  tx: Tx,
  householdId: string,
  timezone: string,
  nowIso: string,
  limits: ExtractLimits,
  /** A batch being collected: its own messages were charged at submit, so they are not "in flight" for this budget. */
  excludeBatchId: string | null = null,
): Promise<Budget> {
  const since = localDayStart(nowIso, timezone);
  const runs = await tx.execute<{ n: string }>(sql`select count(*)::text as n from ai_runs
    where household_id = ${householdId} and purpose = 'extract' and created_at >= ${since}::timestamptz`);
  const inFlight = await tx.execute<{ n: string }>(sql`select count(*)::text as n from email_messages
    where household_id = ${householdId} and stage = 'discovered' and ai_batch_id is not null
      and ai_batch_id is distinct from ${excludeBatchId}`);
  const fresh = await tx.execute<{ n: string }>(sql`select count(*)::text as n from email_messages
    where household_id = ${householdId} and extract_new_sender and extract_charged_at >= ${since}::timestamptz`);
  return budgetOf(
    limits,
    Number(runs.rows[0]?.n ?? 0) + Number(inFlight.rows[0]?.n ?? 0),
    Number(fresh.rows[0]?.n ?? 0),
  );
}

/** Records that a message is being charged now (before the call or the batch reservation). */
export async function markCharged(
  tx: Tx,
  householdId: string,
  messageId: string,
  newSender: boolean,
  nowIso: string,
): Promise<void> {
  await tx.execute(sql`update email_messages set extract_charged_at = ${nowIso}::timestamptz,
      extract_new_sender = ${newSender}
    where id = ${messageId} and household_id = ${householdId}`);
}
