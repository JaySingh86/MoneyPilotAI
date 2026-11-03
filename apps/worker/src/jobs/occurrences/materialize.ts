// Job `occurrences.materialize` (BACKEND_PLAN §7.1, §9): keeps each household's occurrences from 35 days
// back to 400 days ahead. Triggered by an item change (one item, optionally a rebuild of its future) and
// nightly at 02:00 UTC (one job per household). Safe to run twice: inserts are keyed on
// (item_id, scheduled_on) and a rebuild only replaces future `scheduled` rows.
//
// The queue wiring (pg-boss) is not part of this package yet; `registerMaterialize` below is what the
// scheduler calls. The nightly fan-out needs the list of households, which no app role can read
// (Q-051), so a scheduler enqueues one job per household.
import { z } from "zod";
import { materializeForJob, type MaterializeResult, type WorkerDb } from "@mp/db";

export const MATERIALIZE_QUEUE = "occurrences.materialize";

export const MaterializeJob = z.object({
  householdId: z.uuid(),
  itemId: z.uuid().optional(),
  /** Delete and recreate the item's future `scheduled` occurrences (schedule changed). */
  rebuild: z.boolean().optional(),
});
export type MaterializeJob = z.infer<typeof MaterializeJob>;

/** pg-boss singleton key: one running job per item (or per household for the nightly sweep). */
export function materializeSingletonKey(job: MaterializeJob): string {
  return `${MATERIALIZE_QUEUE}:${job.itemId ?? job.householdId}`;
}

export interface MaterializeDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

export async function handleMaterialize(deps: MaterializeDeps, data: unknown): Promise<MaterializeResult> {
  const job = MaterializeJob.parse(data);
  return deps.db.withJobTx(job.householdId, (tx) => materializeForJob(tx, job, deps.now()));
}
