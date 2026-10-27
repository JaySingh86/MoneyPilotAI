import { createLogger } from "@mp/observability";

// WP-03/WP-06 replace this with pg-boss queues and cron schedules.
const log = createLogger("worker");
log.info("worker started (no jobs registered yet)");

const heartbeat = setInterval(() => log.debug("worker heartbeat"), 60_000);

function shutdown(): void {
  clearInterval(heartbeat);
  log.info("worker stopped");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
