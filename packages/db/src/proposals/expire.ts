// Proposal expiry (BACKEND_PLAN §7.3: proposals expire after 7 days). Shared by the hourly worker job
// `proposals.expire`. Runs inside a caller-provided transaction as mp_worker: RLS scopes it to one household.
// Idempotent: only `pending` proposals past `expires_at` change.
import { sql } from "drizzle-orm";
import type { Tx } from "../tx";

/** Marks the household's overdue pending proposals `expired`. `nowIso` is the job clock (UTC instant). */
export async function expireProposals(tx: Tx, householdId: string, nowIso: string): Promise<number> {
  const res = await tx.execute(sql`update proposals
      set status = 'expired', decision_note = 'Not decided within 7 days.'
    where household_id = ${householdId} and status = 'pending' and expires_at <= ${nowIso}::timestamptz`);
  return res.rowCount ?? 0;
}
