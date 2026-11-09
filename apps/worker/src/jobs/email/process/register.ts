// Queue, worker and schedule registration for the email processing pipeline (WP-22), called from `registerEmailJobs`
// (WP-21's register.ts). Without an Anthropic key the pipeline is not started at all: no job reads a message for a model
// and the discovered messages simply wait (a warning says so once at start).
import type { Job, PgBoss } from "pg-boss";
import type { AiClient } from "@mp/ai";
import type { Logger } from "@mp/observability";
import type { WorkerDb } from "@mp/db";
import {
  AI_BATCH_COLLECT_QUEUE,
  AI_BATCH_QUEUE_OPTIONS,
  AI_BATCH_SUBMIT_QUEUE,
  handleAiBatchCollect,
  handleAiBatchSubmit,
} from "../../ai/batch";
import { guardJob } from "../../guard";
import { limitsFromEnv, type LimitsEnv } from "./limits";
import type { EmailJobDeps } from "../discover/connection";
import { EMAIL_PROCESS_QUEUE, EMAIL_PROCESS_QUEUE_OPTIONS, handleEmailProcess } from "./process";
import { EMAIL_PROCESS_SWEEP_CRON, EMAIL_PROCESS_SWEEP_QUEUE, handleEmailProcessSweep } from "./sweep";

interface Deps {
  db: WorkerDb;
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
  pollingIntervalSeconds?: number | undefined;
  /** Where the cost caps come from (B1). Default: process.env. */
  env?: LimitsEnv | undefined;
}

export async function registerEmailProcessJobs(
  boss: PgBoss,
  deps: Deps,
  jobDeps: EmailJobDeps,
  ai: AiClient | null | undefined,
): Promise<void> {
  if (!ai) {
    deps.log.warn(
      "no ANTHROPIC_API_KEY is set: email messages are discovered but not read (email.process is off)",
    );
    return;
  }
  const processDeps = { ...jobDeps, ai, sender: boss, limits: limitsFromEnv(deps.env ?? process.env) };
  await boss.createQueue(EMAIL_PROCESS_QUEUE, EMAIL_PROCESS_QUEUE_OPTIONS);
  await boss.createQueue(AI_BATCH_SUBMIT_QUEUE, AI_BATCH_QUEUE_OPTIONS);
  await boss.createQueue(AI_BATCH_COLLECT_QUEUE, AI_BATCH_QUEUE_OPTIONS);
  await boss.createQueue(EMAIL_PROCESS_SWEEP_QUEUE, { retryLimit: 1, retryDelay: 30 });

  const options = {
    batchSize: 1,
    ...(deps.pollingIntervalSeconds ? { pollingIntervalSeconds: deps.pollingIntervalSeconds } : {}),
  };
  await boss.work(EMAIL_PROCESS_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const lastAttempt = job.retryCount >= EMAIL_PROCESS_QUEUE_OPTIONS.retryLimit;
      const r = await guardJob(EMAIL_PROCESS_QUEUE, deps.log, () =>
        handleEmailProcess(processDeps, job.data, { lastAttempt }),
      );
      deps.log.info({ outcome: r.outcome, ...("counts" in r ? r.counts : {}) }, "email processed");
    }
  });
  await boss.work(AI_BATCH_SUBMIT_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const lastAttempt = job.retryCount >= AI_BATCH_QUEUE_OPTIONS.retryLimit;
      const r = await guardJob(AI_BATCH_SUBMIT_QUEUE, deps.log, () =>
        handleAiBatchSubmit(processDeps, job.data, { lastAttempt }),
      );
      deps.log.info({ outcome: r.outcome }, "email batch submitted");
    }
  });
  await boss.work(AI_BATCH_COLLECT_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const lastAttempt = job.retryCount >= AI_BATCH_QUEUE_OPTIONS.retryLimit;
      const r = await guardJob(AI_BATCH_COLLECT_QUEUE, deps.log, () =>
        handleAiBatchCollect(processDeps, job.data, { lastAttempt }),
      );
      deps.log.info({ outcome: r.outcome, ...("counts" in r ? r.counts : {}) }, "email batch collected");
    }
  });
  await boss.work(EMAIL_PROCESS_SWEEP_QUEUE, options, async () => {
    await guardJob(EMAIL_PROCESS_SWEEP_QUEUE, deps.log, () =>
      handleEmailProcessSweep({ db: deps.db, sender: boss }),
    );
  });
  await boss.schedule(EMAIL_PROCESS_SWEEP_QUEUE, EMAIL_PROCESS_SWEEP_CRON, null, { tz: "UTC" });
}
