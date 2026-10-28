import { createLogger } from "@mp/observability";
import { buildServer } from "./server";

const log = createLogger("api");
const port = Number(process.env.API_PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN;

// TODO(WP-05): pass `authenticate` (Clerk) and a DB-backed idempotency store (lib/idempotency-store.ts).
const app = buildServer({
  logger: log,
  corsOrigins: webOrigin ? [webOrigin] : [],
  // Behind the ALB in AWS (one hop). Locally nothing is in front, so X-Forwarded-For is not trusted.
  trustProxy: process.env.NODE_ENV === "production" ? 1 : false,
});

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => log.info({ port }, "api listening"))
  .catch((err: unknown) => {
    log.error({ err }, "api failed to start");
    process.exit(1);
  });
