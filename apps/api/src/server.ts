import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// WP-08 replaces this with the full platform (errors, idempotency, OpenAPI, module registry).
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
