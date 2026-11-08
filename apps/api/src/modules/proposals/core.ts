// Proposal rows: creating one and reading one back (BACKEND_PLAN §7.3). Kept free of any import from the
// items or goals modules, so those modules can create proposals without a cycle; applying a proposal lives
// in ./apply.ts.
import { sql } from "drizzle-orm";
import { notifyProposalCreated } from "../notify/hooks";
import {
  AppError,
  MAX_PENDING_PROPOSALS,
  PROPOSAL_TTL_DAYS,
  proposalKind,
  proposalTarget,
  type Proposal,
  type ProposalPayload,
} from "@mp/contracts";
import type { Tx } from "@mp/db";

type Row = Record<string, unknown>;

/** A change that either applied at once or became a proposal for the other member (HTTP 202). */
export type Gated<T> = { applied: T } | { proposal: Proposal };

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

export const PROPOSAL_COLUMNS = sql`id, household_id, kind, payload, calc_snapshot_id, proposed_by, status,
  decided_by, decision_note, ${iso("decided_at")} as decided_at, ${iso("expires_at")} as expires_at,
  ${iso("created_at")} as created_at`;

/** `nowIso` is the request clock: a pending proposal past its expiry reads as `expired`. */
export function toProposal(r: Row, nowIso: string): Proposal {
  const expiresAt = str(r.expires_at);
  const status = r.status as Proposal["status"];
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    kind: r.kind as Proposal["kind"],
    payload: r.payload as ProposalPayload,
    calcSnapshotId: strOrNull(r.calc_snapshot_id),
    proposedBy: str(r.proposed_by),
    status: status === "pending" && Date.parse(expiresAt) <= Date.parse(nowIso) ? "expired" : status,
    decidedBy: strOrNull(r.decided_by),
    decidedAt: strOrNull(r.decided_at),
    decisionNote: strOrNull(r.decision_note),
    expiresAt,
    createdAt: str(r.created_at),
  };
}

export function expiryFor(nowIso: string): string {
  return new Date(Date.parse(nowIso) + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export interface NewProposal {
  householdId: string;
  proposedBy: string;
  payload: ProposalPayload;
  nowIso: string;
  calcSnapshotId?: string | null;
}

/**
 * Inserts a pending proposal that expires 7 days from `nowIso`, and records the audit event.
 * One pending proposal per (payload type, target) and at most 20 open per household: otherwise 409.
 * Proposals past their 7 days are recorded as expired first, so they never block a new one.
 */
export async function insertProposal(tx: Tx, p: NewProposal): Promise<Proposal> {
  await tx.execute(sql`update proposals set status = 'expired', decision_note = 'Not decided within 7 days.'
    where household_id = ${p.householdId} and status = 'pending' and expires_at <= ${p.nowIso}::timestamptz`);
  const target = proposalTarget(p.payload) ?? "";
  const open = await tx.execute<{ n: string; same: string }>(sql`select count(*)::text as n,
      count(*) filter (where payload ->> 'type' = ${p.payload.type}
        and coalesce(payload ->> 'occurrenceId', payload ->> 'plannedExpenseId', payload ->> 'goalId',
                     payload ->> 'itemId', '') = ${target})::text as same
    from proposals where household_id = ${p.householdId} and status = 'pending'`);
  if (Number(open.rows[0]?.same ?? 0) > 0) {
    throw new AppError("conflict", 409, "There is already a request waiting for approval for this.");
  }
  if (Number(open.rows[0]?.n ?? 0) >= MAX_PENDING_PROPOSALS) {
    throw new AppError("conflict", 409, "Too many requests are waiting for approval. Decide some first.");
  }
  const res = await tx.execute(sql`insert into proposals
      (household_id, kind, payload, calc_snapshot_id, proposed_by, expires_at)
    values (${p.householdId}, ${proposalKind(p.payload)}, ${JSON.stringify(p.payload)}::jsonb,
      ${p.calcSnapshotId ?? null}, ${p.proposedBy}, ${expiryFor(p.nowIso)}::timestamptz)
    returning ${PROPOSAL_COLUMNS}`);
  const row = res.rows[0];
  if (!row) throw new Error("proposal insert returned no row");
  const proposal = toProposal(row, p.nowIso);
  await tx.execute(sql`insert into audit_events
      (household_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata)
    values (${p.householdId}, ${p.proposedBy}, 'user', 'proposal.created', 'proposal', ${proposal.id},
      ${JSON.stringify({ type: p.payload.type })}::jsonb)`);
  // Every way a proposal is created (this module, goals, items) ends here, so the other member hears about
  // it exactly once (WP-15, BACKEND_PLAN §7.3 step 2).
  await notifyProposalCreated(tx, { householdId: p.householdId, userId: p.proposedBy }, proposal.id);
  return proposal;
}
