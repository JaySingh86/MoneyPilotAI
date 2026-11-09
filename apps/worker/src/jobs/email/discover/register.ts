// Queue, worker and schedule registration for the email connector jobs (WP-21), called once from `registerJobs`
// (boss.ts). Without provider settings or a key provider the connector jobs are not started and the sweep never runs:
// nothing reads a mailbox on a worker that was not configured for it.
import type { Job, PgBoss } from "pg-boss";
import type { Logger } from "@mp/observability";
import type { AiClient } from "@mp/ai";
import type { WorkerDb } from "@mp/db";
import { createKeyProvider, type CryptoDeps, type CryptoEnv, type KeyProvider } from "@mp/crypto";
import { createProvidersFromEnv, type ProviderEnv } from "@mp/email/providers";
import { guardJob } from "../../guard";
import {
  EMAIL_BACKFILL_QUEUE,
  EMAIL_BACKFILL_QUEUE_OPTIONS,
  handleEmailBackfill,
} from "../backfill/backfill";
import { EMAIL_REVOKE_QUEUE, EMAIL_REVOKE_QUEUE_OPTIONS, handleEmailRevoke } from "../watch/revoke";
import { EMAIL_WATCH_QUEUE, EMAIL_WATCH_QUEUE_OPTIONS, handleEmailWatch } from "../watch/watch";
import { registerEmailProcessJobs } from "../process/register";
import type { LimitsEnv } from "../process/limits";
import type { EmailJobDeps } from "./connection";
import { EMAIL_DISCOVER_QUEUE, EMAIL_DISCOVER_QUEUE_OPTIONS, handleEmailDiscover } from "./discover";
import {
  EMAIL_SWEEP_CRON,
  EMAIL_SWEEP_QUEUE,
  EMAIL_WATCH_SWEEP_CRON,
  EMAIL_WATCH_SWEEP_QUEUE,
  handleEmailSweep,
  handleEmailWatchSweep,
  pollMinutesFrom,
} from "./sweep";

export interface EmailEnv extends ProviderEnv, CryptoEnv, LimitsEnv {
  EMAIL_WEBHOOK_SECRET?: string | undefined;
  EMAIL_POLL_MINUTES?: string | undefined;
}

interface Deps {
  db: WorkerDb;
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
  pollingIntervalSeconds?: number;
  /** Tests inject their own providers and key provider. Default: from the environment. */
  connectors?: Pick<EmailJobDeps, "providers" | "keys" | "graphStateSecret">;
  env?: EmailEnv;
  crypto?: CryptoDeps;
  /** The extraction client (WP-22). Without one the processing pipeline is not started. */
  ai?: AiClient | null;
}

/** Stands in for the key provider when none is configured: the token cannot be opened, so the job keeps it and retries. */
const missingKeys: KeyProvider = {
  keyId: () => "none",
  generateDataKey: async () => {
    throw new Error("No token key is configured.");
  },
  decryptDataKey: async () => {
    throw new Error("No token key is configured.");
  },
};

/**
 * The connector's dependencies from the environment. Never null: with no provider configured the revoke job and the
 * sweep still run, because a disconnected mailbox must have its token revoked and deleted whatever the settings are.
 * A partly configured provider throws. A missing or refused key throws when a provider is configured; without one
 * the revoke job finds it cannot open any token and keeps it.
 */
export function loadEmailJobDeps(
  env: EmailEnv,
  crypto: CryptoDeps = {},
): Pick<EmailJobDeps, "providers" | "keys" | "graphStateSecret"> {
  const providers = createProvidersFromEnv(env);
  const configured = Boolean(providers.gmail || providers.outlook);
  const secret = Buffer.from(env.EMAIL_WEBHOOK_SECRET ?? "", "base64");
  if (configured && secret.length < 32) {
    throw new Error("EMAIL_WEBHOOK_SECRET must be base64 of at least 32 random bytes.");
  }
  let keys: KeyProvider;
  try {
    keys = createKeyProvider(env, crypto);
  } catch (err) {
    if (configured) throw err;
    keys = missingKeys;
  }
  return { providers, keys, graphStateSecret: secret };
}

export async function registerEmailJobs(boss: PgBoss, deps: Deps): Promise<void> {
  // Always registered, even with no provider configured: a disconnect must be finished (revoke, then delete the token).
  const email = deps.connectors ?? loadEmailJobDeps(deps.env ?? process.env, deps.crypto);
  if (Object.keys(email.providers).length === 0) {
    deps.log.warn("no mailbox provider is configured: only disconnects are processed");
  }
  const jobDeps: EmailJobDeps = { db: deps.db, now: deps.now, log: deps.log, ...email };
  const queues = [
    [EMAIL_DISCOVER_QUEUE, EMAIL_DISCOVER_QUEUE_OPTIONS],
    [EMAIL_BACKFILL_QUEUE, EMAIL_BACKFILL_QUEUE_OPTIONS],
    [EMAIL_WATCH_QUEUE, EMAIL_WATCH_QUEUE_OPTIONS],
    [EMAIL_REVOKE_QUEUE, EMAIL_REVOKE_QUEUE_OPTIONS],
  ] as const;
  for (const [name, options] of queues) await boss.createQueue(name, options);
  await boss.createQueue(EMAIL_SWEEP_QUEUE, { retryLimit: 1, retryDelay: 30 });
  await boss.createQueue(EMAIL_WATCH_SWEEP_QUEUE, { retryLimit: 3, retryDelay: 60, retryBackoff: true });

  const options = {
    batchSize: 1,
    ...(deps.pollingIntervalSeconds ? { pollingIntervalSeconds: deps.pollingIntervalSeconds } : {}),
  };
  await boss.work(EMAIL_DISCOVER_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const r = await guardJob(EMAIL_DISCOVER_QUEUE, deps.log, () => handleEmailDiscover(jobDeps, job.data));
      deps.log.info({ outcome: r.outcome }, "email discovered");
    }
  });
  await boss.work(EMAIL_BACKFILL_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const r = await guardJob(EMAIL_BACKFILL_QUEUE, deps.log, () => handleEmailBackfill(jobDeps, job.data));
      deps.log.info({ outcome: r.outcome }, "email backfill ran");
    }
  });
  await boss.work(EMAIL_WATCH_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const lastAttempt = job.retryCount >= EMAIL_WATCH_QUEUE_OPTIONS.retryLimit;
      const r = await guardJob(EMAIL_WATCH_QUEUE, deps.log, () =>
        handleEmailWatch(jobDeps, job.data, { lastAttempt }),
      );
      deps.log.info({ outcome: r.outcome }, "email watch ran");
    }
  });
  await boss.work(EMAIL_REVOKE_QUEUE, options, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const lastAttempt = job.retryCount >= EMAIL_REVOKE_QUEUE_OPTIONS.retryLimit;
      const r = await guardJob(EMAIL_REVOKE_QUEUE, deps.log, () =>
        handleEmailRevoke(jobDeps, job.data, { lastAttempt }),
      );
      deps.log.info({ outcome: r.outcome }, "email disconnect finished");
    }
  });
  await boss.work(EMAIL_SWEEP_QUEUE, options, async () => {
    await guardJob(EMAIL_SWEEP_QUEUE, deps.log, () =>
      handleEmailSweep({
        db: deps.db,
        sender: boss,
        now: deps.now,
        log: deps.log,
        pollMinutes: pollMinutesFrom(deps.env ?? process.env),
      }),
    );
  });
  await boss.work(EMAIL_WATCH_SWEEP_QUEUE, options, async () => {
    await guardJob(EMAIL_WATCH_SWEEP_QUEUE, deps.log, () =>
      handleEmailWatchSweep({ db: deps.db, sender: boss, now: deps.now, log: deps.log }),
    );
  });
  await boss.schedule(EMAIL_SWEEP_QUEUE, EMAIL_SWEEP_CRON, null, { tz: "UTC" });
  await boss.schedule(EMAIL_WATCH_SWEEP_QUEUE, EMAIL_WATCH_SWEEP_CRON, null, { tz: "UTC" });
  // WP-22: email.process, ai.batch.submit / collect and their sweep (only with an Anthropic key).
  await registerEmailProcessJobs(boss, deps, jobDeps, deps.ai);
}
