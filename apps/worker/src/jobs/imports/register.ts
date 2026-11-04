// Queue and schedule registration for the CSV import jobs, called once from `registerJobs` (boss.ts).
import type { Job, PgBoss } from "pg-boss";
import type { Logger } from "@mp/observability";
import type { WorkerDb } from "@mp/db";
import { guardJob } from "../guard";
import { IMPORTS_PROCESS_QUEUE, IMPORTS_PROCESS_QUEUE_OPTIONS, handleImportsProcess } from "./process";
import { importFileStore } from "./storage";
import {
  IMPORTS_SWEEP_CRON,
  IMPORTS_SWEEP_QUEUE,
  TRANSACTIONS_PURGE_CRON,
  TRANSACTIONS_PURGE_QUEUE,
  handleImportsSweep,
  handleTransactionsPurge,
} from "./sweep";

interface Deps {
  db: WorkerDb;
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
  pollingIntervalSeconds?: number;
}

export async function registerImportJobs(boss: PgBoss, deps: Deps): Promise<void> {
  await boss.createQueue(IMPORTS_PROCESS_QUEUE, IMPORTS_PROCESS_QUEUE_OPTIONS);
  await boss.createQueue(IMPORTS_SWEEP_QUEUE, { retryLimit: 1, retryDelay: 30 });
  await boss.createQueue(TRANSACTIONS_PURGE_QUEUE, { retryLimit: 3, retryDelay: 60, retryBackoff: true });
  const options = {
    batchSize: 1,
    ...(deps.pollingIntervalSeconds ? { pollingIntervalSeconds: deps.pollingIntervalSeconds } : {}),
  };
  await boss.work(IMPORTS_PROCESS_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const result = await guardJob(IMPORTS_PROCESS_QUEUE, deps.log, () =>
        handleImportsProcess({ db: deps.db, now: deps.now, store: importFileStore }, job.data),
      );
      deps.log.info({ outcome: result.outcome }, "csv import processed");
    }
  });
  await boss.work(IMPORTS_SWEEP_QUEUE, options, async () => {
    await guardJob(IMPORTS_SWEEP_QUEUE, deps.log, () => handleImportsSweep({ db: deps.db, sender: boss }));
  });
  await boss.work(TRANSACTIONS_PURGE_QUEUE, options, async () => {
    const deleted = await guardJob(TRANSACTIONS_PURGE_QUEUE, deps.log, () =>
      handleTransactionsPurge({ db: deps.db, now: deps.now }),
    );
    deps.log.info({ deleted }, "old transactions purged");
  });
  await boss.schedule(IMPORTS_SWEEP_QUEUE, IMPORTS_SWEEP_CRON, null, { tz: "UTC" });
  await boss.schedule(TRANSACTIONS_PURGE_QUEUE, TRANSACTIONS_PURGE_CRON, null, { tz: "UTC" });
}
