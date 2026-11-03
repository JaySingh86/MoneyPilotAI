// Job `occurrences.sweep` (BACKEND_PLAN §9, Q-051): the nightly 02:00 UTC trigger of `occurrences.materialize`.
// No app role can read the household table, so the list comes from the SECURITY DEFINER
// `app_list_household_ids()` (ids only, executable by mp_worker). One materialize job per household, with the
// same singleton key the item-change trigger uses, so a sweep never doubles a running job.
import type { WorkerDb } from "@mp/db";
import type { JobSender } from "../plan/recompute";
import { MATERIALIZE_QUEUE, materializeSingletonKey } from "./materialize";

export const OCCURRENCES_SWEEP_QUEUE = "occurrences.sweep";
/** 02:00 UTC every day. */
export const OCCURRENCES_SWEEP_CRON = "0 2 * * *";

export interface SweepDeps {
  db: WorkerDb;
  sender: JobSender;
}

export async function handleOccurrencesSweep(
  deps: SweepDeps,
): Promise<{ households: number; enqueued: number }> {
  const ids = await deps.db.listHouseholdIds();
  let enqueued = 0;
  for (const householdId of ids) {
    const id = await deps.sender.send(
      MATERIALIZE_QUEUE,
      { householdId },
      { singletonKey: materializeSingletonKey({ householdId }) },
    );
    if (id !== null) enqueued++;
  }
  return { households: ids.length, enqueued };
}
