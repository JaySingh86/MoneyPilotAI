// One log line per request, through the shared redacting logger (hard rule 8). Only the route template
// is logged (`/v1/households/:hid/items/:id`), never the raw path or query: paths carry ids and tokens,
// and query strings carry OAuth `code` and `state`. Bodies and headers are never logged.
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const requestLoggingPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? null,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });
};

export const requestLogging = fp(requestLoggingPlugin, { name: "mp-request-logging" });
