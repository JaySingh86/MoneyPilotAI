// Job `email.process.sweep` (every minute): turns what discovery left in `email_messages` into jobs, because nothing else
// enqueues them (the API cannot, Q-105; discover and backfill only write rows):
//   * connections with new (`discover`) messages waiting        -> email.process (direct calls)
//   * connections with backfill messages not yet in a batch     -> ai.batch.submit
//   * batches that still hold messages                          -> ai.batch.collect (at most one poll per 2 minutes)
// Every job has a singleton key, so a sweep that runs twice, or one that overlaps a running job, queues nothing extra.
import type { WorkerDb } from "@mp/db";
import {
  AI_BATCH_COLLECT_QUEUE,
  AI_BATCH_SUBMIT_QUEUE,
  aiBatchCollectSingletonKey,
  aiBatchSubmitSingletonKey,
} from "../../ai/batch";
import type { JobSender } from "../../plan/recompute";
import { EMAIL_PROCESS_QUEUE, emailProcessSingletonKey } from "./process";
import * as repo from "./repo";

export const EMAIL_PROCESS_SWEEP_QUEUE = "email.process.sweep";
/** Every minute (the smallest pg-boss cron step). */
export const EMAIL_PROCESS_SWEEP_CRON = "* * * * *";
/** A batch is polled at most this often (seconds). */
export const BATCH_POLL_SECONDS = 120;

export interface ProcessSweepDeps {
  db: WorkerDb;
  sender: JobSender;
}

export async function handleEmailProcessSweep(
  deps: ProcessSweepDeps,
): Promise<{ households: number; process: number; submit: number; collect: number }> {
  const ids = await deps.db.listHouseholdIds();
  let process = 0;
  let submit = 0;
  let collect = 0;
  for (const householdId of ids) {
    const found = await deps.db.withJobTx(householdId, async (tx) => ({
      direct: await repo.connectionsWithPending(tx, householdId, "discover"),
      backfill: await repo.connectionsWithPending(tx, householdId, "backfill"),
      batches: await repo.openBatchIds(tx, householdId),
    }));
    for (const connectionId of found.direct) {
      const job = { householdId, connectionId };
      if (
        (await deps.sender.send(EMAIL_PROCESS_QUEUE, job, {
          singletonKey: emailProcessSingletonKey(job),
        })) !== null
      )
        process++;
    }
    for (const connectionId of found.backfill) {
      const job = { householdId, connectionId };
      if (
        (await deps.sender.send(AI_BATCH_SUBMIT_QUEUE, job, {
          singletonKey: aiBatchSubmitSingletonKey(job),
        })) !== null
      )
        submit++;
    }
    for (const batchId of found.batches) {
      const job = { householdId, batchId };
      if (
        (await deps.sender.send(AI_BATCH_COLLECT_QUEUE, job, {
          singletonKey: aiBatchCollectSingletonKey(job),
          singletonSeconds: BATCH_POLL_SECONDS,
        })) !== null
      )
        collect++;
    }
  }
  return { households: ids.length, process, submit, collect };
}
