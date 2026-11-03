// Job `proposals.expire` (BACKEND_PLAN §7.3, §9): hourly. Marks pending proposals older than their 7 days
// `expired`. The scheduler enqueues one job per household (`app_list_household_ids()`, Q-051); the run is
// idempotent, so a repeat changes nothing. Queue wiring (pg-boss) lands with the worker runtime (WP-12).
import { z } from "zod";
import { expireProposals, type WorkerDb } from "@mp/db";

export const PROPOSALS_EXPIRE_QUEUE = "proposals.expire";

export const ProposalsExpireJob = z.object({ householdId: z.uuid() });
export type ProposalsExpireJob = z.infer<typeof ProposalsExpireJob>;

/** One running job per household. */
export function proposalsExpireSingletonKey(job: ProposalsExpireJob): string {
  return `${PROPOSALS_EXPIRE_QUEUE}:${job.householdId}`;
}

export interface ProposalsExpireDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

/** Returns how many proposals expired. */
export async function handleProposalsExpire(deps: ProposalsExpireDeps, data: unknown): Promise<number> {
  const job = ProposalsExpireJob.parse(data);
  return deps.db.withJobTx(job.householdId, (tx) => expireProposals(tx, job.householdId, deps.now()));
}
