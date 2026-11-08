import { createWorkerDb, DbTlsError, pgConfig, tlsWarning } from "@mp/db";
import { createEmailSender, type EmailSender } from "@mp/notify";
import { createLogger } from "@mp/observability";
import { MAX_CSV_BYTES } from "@mp/detection";
import { startJobs } from "./boss";
import { loadEmailJobDeps } from "./jobs/email/discover/register";
import { createS3ImportFileStore, loadS3Config } from "./jobs/imports/s3-storage";
import { configureImportFileStore } from "./jobs/imports/storage";
import { StartupCheckError, checkBossConnection } from "./startup-checks";

const log = createLogger("worker");

const databaseUrl = process.env.WORKER_DATABASE_URL;
if (!databaseUrl) {
  log.error("WORKER_DATABASE_URL is not set");
  process.exit(1);
}
// pg-boss keeps its queue tables in its own `pgboss` schema and creates it on first start, which the
// mp_worker role cannot do. Locally the migrator URL does. In production PGBOSS_DATABASE_URL is required and
// its role must not be a superuser, bypass RLS or be mp_migrator (M2; WP-09 adds the mp_queue role, Q-105).
let bossUrl: string;
try {
  bossUrl = await checkBossConnection(process.env);
} catch (err) {
  log.error({ err }, err instanceof StartupCheckError ? err.message : "could not check the queue connection");
  process.exit(1);
}

// Email delivery (WP-15): SES in production, Mailpit locally. A production worker without EMAIL_TRANSPORT and
// WEB_ORIGIN (the origin email links point to) stops here instead of silently never sending.
let email: EmailSender;
let appUrl: string;
try {
  email = createEmailSender(process.env);
  appUrl = process.env.WEB_ORIGIN ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3100");
  new URL(appUrl);
} catch (err) {
  log.error({ err }, "email delivery is misconfigured; refusing to start");
  process.exit(1);
}

// Email connectors (WP-21): off without provider settings; a partly configured provider, a missing secret or an
// unusable key provider stops the worker here instead of failing on the first job.
let emailConnectors: ReturnType<typeof loadEmailJobDeps>;
try {
  emailConnectors = loadEmailJobDeps(process.env);
} catch (err) {
  log.error(
    { reason: err instanceof Error ? err.message : "invalid" },
    "email connectors are misconfigured; refusing to start",
  );
  process.exit(1);
}

// CSV file store (WP-32). Without S3_* settings an import job fails and retries instead of silently doing nothing.
try {
  const s3 = loadS3Config(process.env);
  if (s3) configureImportFileStore(createS3ImportFileStore(s3, MAX_CSV_BYTES));
  else log.warn("S3_ENDPOINT is not set: CSV imports cannot be processed");
} catch (err) {
  log.error(
    { reason: err instanceof Error ? err.message : "invalid" },
    "storage is misconfigured; refusing to start",
  );
  process.exit(1);
}

// TLS to the database (ADR-020): Supabase hosts are verified; production refuses an unverified remote database.
try {
  const tlsProblem = tlsWarning([databaseUrl, bossUrl]);
  if (tlsProblem) log.warn(tlsProblem);
  for (const url of [databaseUrl, bossUrl]) pgConfig(url);
} catch (err) {
  if (!(err instanceof DbTlsError)) throw err;
  log.error({ reason: err.message }, "database TLS is misconfigured; refusing to start");
  process.exit(1);
}

const db = createWorkerDb({ connectionString: databaseUrl });
const jobs = await startJobs({
  bossUrl,
  // The pgboss schema is created by a migration and mp_queue cannot change it (WP-09, Q-105).
  // With PGBOSS_DATABASE_URL (mp_queue: Supabase, AWS) the schema comes from the migration; locally without it the
  // migrator fallback URL lets pg-boss create its own.
  migrate: process.env.NODE_ENV !== "production" && !process.env.PGBOSS_DATABASE_URL,
  db,
  now: () => new Date().toISOString(),
  log,
  email,
  appUrl,
  emailConnectors,
});
log.info("worker started");

let stopping: Promise<void> | null = null;
function shutdown(): void {
  stopping ??= (async () => {
    try {
      await jobs.stop();
      await db.close();
      log.info("worker stopped");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "worker did not stop cleanly");
      process.exit(1);
    }
  })();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
