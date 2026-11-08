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
import type { EmailSender } from "@mp/notify";
import { guardJob } from "./jobs/guard";
import { registerImportJobs } from "./jobs/imports/register";
import {
  NOTIFICATIONS_DISPATCH_QUEUE,
  NOTIFICATIONS_DISPATCH_QUEUE_OPTIONS,
  NOTIFICATIONS_SWEEP_CRON,
  NOTIFICATIONS_SWEEP_QUEUE,
  handleNotificationsDispatch,
  handleNotificationsSweep,
} from "./jobs/notifications/dispatch";
import { PROPOSALS_EXPIRE_QUEUE, handleProposalsExpire } from "./jobs/proposals/expire";
import {
  PROPOSALS_EXPIRE_SWEEP_CRON,
  PROPOSALS_EXPIRE_SWEEP_QUEUE,
  handleProposalsExpireSweep,
} from "./jobs/proposals/sweep";
import {
  REMINDERS_PLAN_QUEUE,
  REMINDERS_PLAN_QUEUE_OPTIONS,
  REMINDERS_SWEEP_CRON,
  REMINDERS_SWEEP_QUEUE,
  handleRemindersPlan,
  handleRemindersSweep,
} from "./jobs/reminders/plan";
import { TASKS_AUTO_COMPLETE_QUEUE, handleTasksAutoComplete } from "./jobs/tasks/auto-complete";
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
  /**
   * Email delivery for `notifications.dispatch` and the web origin its links point to. The worker's entry
   * point always supplies both; without them the dispatch worker is not started (some tests).
   */
  email?: EmailSender;
  appUrl?: string;
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
  // WP-15: reminders and notifications.
  { name: REMINDERS_SWEEP_QUEUE, options: { retryLimit: 3, retryDelay: 60, retryBackoff: true } },
  { name: REMINDERS_PLAN_QUEUE, options: REMINDERS_PLAN_QUEUE_OPTIONS },
  { name: NOTIFICATIONS_SWEEP_QUEUE, options: { retryLimit: 1, retryDelay: 10 } },
  { name: NOTIFICATIONS_DISPATCH_QUEUE, options: NOTIFICATIONS_DISPATCH_QUEUE_OPTIONS },
  // WP-13 jobs, registered here (Q-117).
  { name: PROPOSALS_EXPIRE_SWEEP_QUEUE, options: { retryLimit: 3, retryDelay: 60, retryBackoff: true } },
  {
    name: PROPOSALS_EXPIRE_QUEUE,
    options: { policy: "short", retryLimit: 3, retryDelay: 30, retryBackoff: true },
  },
  { name: TASKS_AUTO_COMPLETE_QUEUE, options: { retryLimit: 3, retryDelay: 10, retryBackoff: true } },
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
  // WP-15: the 15-minute planner trigger and the per-household planner.
  await boss.work(REMINDERS_SWEEP_QUEUE, options, async () => {
    const result = await guardJob(REMINDERS_SWEEP_QUEUE, deps.log, () =>
      handleRemindersSweep({ db: deps.db, sender: boss }),
    );
    deps.log.info(result, "reminders sweep enqueued");
  });
  await boss.work(REMINDERS_PLAN_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const result = await guardJob(REMINDERS_PLAN_QUEUE, deps.log, () =>
        handleRemindersPlan(deps, job.data),
      );
      deps.log.info(result, "reminders planned");
    }
  });

  // WP-15: the every-minute dispatch trigger and the per-household dispatcher (needs a mail sender).
  const mail = deps.email && deps.appUrl ? { email: deps.email, appUrl: deps.appUrl } : null;
  if (mail) {
    await boss.work(NOTIFICATIONS_SWEEP_QUEUE, options, async () => {
      await guardJob(NOTIFICATIONS_SWEEP_QUEUE, deps.log, () =>
        handleNotificationsSweep({ db: deps.db, sender: boss }),
      );
    });
    await boss.work(NOTIFICATIONS_DISPATCH_QUEUE, options, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        const result = await guardJob(NOTIFICATIONS_DISPATCH_QUEUE, deps.log, () =>
          handleNotificationsDispatch({ db: deps.db, now: deps.now, ...mail }, job.data),
        );
        deps.log.info(result, "notifications dispatched");
      }
    });
  } else {
    deps.log.warn("no email sender configured: notifications.dispatch is not running");
  }

  // WP-13 jobs (Q-117): hourly proposal expiry, and task auto-complete on events.
  await boss.work(PROPOSALS_EXPIRE_SWEEP_QUEUE, options, async () => {
    await guardJob(PROPOSALS_EXPIRE_SWEEP_QUEUE, deps.log, () =>
      handleProposalsExpireSweep({ db: deps.db, sender: boss }),
    );
  });
  await boss.work(PROPOSALS_EXPIRE_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      await guardJob(PROPOSALS_EXPIRE_QUEUE, deps.log, () => handleProposalsExpire(deps, job.data));
    }
  });
  await boss.work(TASKS_AUTO_COMPLETE_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      await guardJob(TASKS_AUTO_COMPLETE_QUEUE, deps.log, () => handleTasksAutoComplete(deps, job.data));
    }
  });

  // Nightly at 02:00 UTC; the sweep fans out one materialize job per household (Q-051).
  await boss.schedule(OCCURRENCES_SWEEP_QUEUE, OCCURRENCES_SWEEP_CRON, null, { tz: "UTC" });
  await registerImportJobs(boss, deps); // WP-16: imports.process, imports.sweep, transactions.purge
  await boss.schedule(REMINDERS_SWEEP_QUEUE, REMINDERS_SWEEP_CRON, null, { tz: "UTC" });
  await boss.schedule(PROPOSALS_EXPIRE_SWEEP_QUEUE, PROPOSALS_EXPIRE_SWEEP_CRON, null, { tz: "UTC" });
  if (mail) await boss.schedule(NOTIFICATIONS_SWEEP_QUEUE, NOTIFICATIONS_SWEEP_CRON, null, { tz: "UTC" });
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
