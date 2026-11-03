import { createWorkerDb } from "@mp/db";
import { createLogger } from "@mp/observability";
import { startJobs } from "./boss";
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

const db = createWorkerDb({ connectionString: databaseUrl });
const jobs = await startJobs({ bossUrl, db, now: () => new Date().toISOString(), log });
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
