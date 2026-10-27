import { createLogger } from "@mp/observability";
import { buildServer } from "./server";

const log = createLogger("api");
const port = Number(process.env.API_PORT ?? 4000);

const app = buildServer();
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => log.info({ port }, "api listening"))
  .catch((err: unknown) => {
    log.error({ err }, "api failed to start");
    process.exit(1);
  });
