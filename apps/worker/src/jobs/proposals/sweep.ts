// Job `proposals.expire.sweep` (BACKEND_PLAN §9, Q-117): the hourly trigger of `proposals.expire`. Fans out one
// job per household with the same singleton key the handler documents, so a sweep never doubles a running job.
import type { WorkerDb } from "@mp/db";
import type { JobSender } from "../plan/recompute";
import { PROPOSALS_EXPIRE_QUEUE, proposalsExpireSingletonKey } from "./expire";

export const PROPOSALS_EXPIRE_SWEEP_QUEUE = "proposals.expire.sweep";
/** At minute 0 of every hour. */
export const PROPOSALS_EXPIRE_SWEEP_CRON = "0 * * * *";

export interface ProposalsSweepDeps {
  db: WorkerDb;
  sender: JobSender;
}

export async function handleProposalsExpireSweep(
  deps: ProposalsSweepDeps,
): Promise<{ households: number; enqueued: number }> {
  const ids = await deps.db.listHouseholdIds();
  let enqueued = 0;
  for (const householdId of ids) {
    const id = await deps.sender.send(
      PROPOSALS_EXPIRE_QUEUE,
      { householdId },
      { singletonKey: proposalsExpireSingletonKey({ householdId }) },
    );
    if (id !== null) enqueued++;
  }
  return { households: ids.length, enqueued };
}
