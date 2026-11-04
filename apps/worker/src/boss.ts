// Minimal pg-boss bootstrap (BACKEND_PLAN §9, ADR-004): creates the queues, attaches the job handlers and
// registers the cron schedules. Other work packages add their queues in `QUEUES` / `registerJobs`.
// Every handler validates its payload with Zod, scopes the database to one household and is idempotent.
import { PgBoss, type Job } from "pg-boss";
import type { Logger } from "@mp/observability";
import type { WorkerDb } from "@mp/db";
import {
  BILLING_DRAIN_CRON,
  BILLING_DRAIN_QUEUE,
  BILLING_SYNC_QUEUE,
  BILLING_SYNC_QUEUE_OPTIONS,
  handleBillingDrain,
  handleBillingSync,
} from "./jobs/billing/sync";
import { guardJob } from "./jobs/guard";
import { MATERIALIZE_QUEUE, handleMaterialize } from "./jobs/occurrences/materialize";
import {
  OCCURRENCES_SWEEP_CRON,
  OCCURRENCES_SWEEP_QUEUE,
  handleOccurrencesSweep,
} from "./jobs/occurrences/sweep";
import {
  PLAN_RECOMPUTE_QUEUE,
  PLAN_RECOMPUTE_QUEUE_OPTIONS,
  handlePlanRecompute,
} from "./jobs/plan/recompute";

export interface JobDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** How often idle workers look for jobs. Default: pg-boss's own (2 s). Tests lower it. */
  pollingIntervalSeconds?: number;
}

/** Queue settings from BACKEND_PLAN §9. `short`: at most one queued job per singleton key. */
const QUEUES = [
  {
    name: MATERIALIZE_QUEUE,
    options: { policy: "short", retryLimit: 5, retryDelay: 10, retryBackoff: true },
  },
  { name: PLAN_RECOMPUTE_QUEUE, options: PLAN_RECOMPUTE_QUEUE_OPTIONS },
  { name: OCCURRENCES_SWEEP_QUEUE, options: { retryLimit: 3, retryDelay: 60, retryBackoff: true } },
  { name: BILLING_SYNC_QUEUE, options: { policy: "short", ...BILLING_SYNC_QUEUE_OPTIONS } }, // WP-25
  { name: BILLING_DRAIN_QUEUE, options: { retryLimit: 1 } }, // WP-25
] as const;

/** Creates the queues, workers and schedules. Safe to call on every start: queues and schedules upsert. */
export async function registerJobs(boss: PgBoss, deps: JobDeps): Promise<void> {
  for (const q of QUEUES) await boss.createQueue(q.name, q.options);

  // One job per fetch (L3): a bad job fails and retries alone, never a batch. Errors are rewrapped with a
  // fixed message (L4) so nothing from the data lands in the job's stored output.
  const options = {
    batchSize: 1,
    ...(deps.pollingIntervalSeconds ? { pollingIntervalSeconds: deps.pollingIntervalSeconds } : {}),
  };
  await boss.work(MATERIALIZE_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs)
      await guardJob(MATERIALIZE_QUEUE, deps.log, () => handleMaterialize(deps, job.data));
  });
  await boss.work(PLAN_RECOMPUTE_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      await guardJob(PLAN_RECOMPUTE_QUEUE, deps.log, () => handlePlanRecompute(deps, job.data));
    }
  });
  await boss.work(OCCURRENCES_SWEEP_QUEUE, options, async () => {
    const result = await guardJob(OCCURRENCES_SWEEP_QUEUE, deps.log, () =>
      handleOccurrencesSweep({ db: deps.db, sender: boss }),
    );
    deps.log.info(result, "nightly occurrence sweep enqueued");
  });

  // WP-25: apply verified billing webhooks (the API cannot enqueue, so the drain finds them every minute).
  await boss.work(BILLING_SYNC_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs)
      await guardJob(BILLING_SYNC_QUEUE, deps.log, () => handleBillingSync(deps, job.data));
  });
  await boss.work(BILLING_DRAIN_QUEUE, options, async () => {
    await guardJob(BILLING_DRAIN_QUEUE, deps.log, () => handleBillingDrain({ db: deps.db, sender: boss }));
  });
  await boss.schedule(BILLING_DRAIN_QUEUE, BILLING_DRAIN_CRON, null, { tz: "UTC" });

  // Nightly at 02:00 UTC; the sweep fans out one materialize job per household (Q-051).
  await boss.schedule(OCCURRENCES_SWEEP_QUEUE, OCCURRENCES_SWEEP_CRON, null, { tz: "UTC" });
}

export interface StartedJobs {
  boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Connects pg-boss (it manages its own `pgboss` schema, so the connection needs the right to create it:
 * PGBOSS_DATABASE_URL, Q-105), registers everything and starts working.
 */
export async function startJobs(options: { bossUrl: string } & JobDeps): Promise<StartedJobs> {
  const boss = new PgBoss(options.bossUrl);
  boss.on("error", (err: unknown) => options.log.error({ err }, "pg-boss error"));
  await boss.start();
  await registerJobs(boss, options);
  return {
    boss,
    stop: () => boss.stop({ graceful: true, timeout: 20_000 }),
  };
}
