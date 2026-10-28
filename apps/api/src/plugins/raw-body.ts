// Keeps the exact request bytes for webhook signature checks (BACKEND_PLAN §8.4). Register it inside the
// webhooks module's own plugin (`await scope.register(rawBody)`): it changes the JSON and text parsers of
// that scope and its children only, never the rest of the API.
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { AppError } from "@mp/contracts";
import { parseJsonSafely } from "../lib/json";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact body bytes; set only inside a scope that registered `rawBody`. */
    rawBody?: Buffer;
  }
}

export interface RawBodyOptions {
  /** Max body size in bytes. Default 1 MiB. */
  bodyLimit?: number;
}

const rawBodyPlugin: FastifyPluginAsync<RawBodyOptions> = async (app, opts) => {
  const bodyLimit = opts.bodyLimit ?? 1024 * 1024;
  app.removeContentTypeParser(["application/json", "text/plain"]);

  // JSON: parsed body plus raw bytes. An empty body parses to undefined.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit }, (request, body, done) => {
    const buf = body as Buffer;
    request.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    try {
      done(null, parseJsonSafely(buf));
    } catch {
      done(new AppError("validation_failed", 400, "The request body is not valid JSON."), undefined);
    }
  });

  // Text (Amazon SNS posts JSON as text/plain): the body stays a string; verify, then parse.
  app.addContentTypeParser("text/plain", { parseAs: "buffer", bodyLimit }, (request, body, done) => {
    const buf = body as Buffer;
    request.rawBody = buf;
    done(null, buf.toString("utf8"));
  });
};

/** Not encapsulated on purpose: it applies to the scope that registers it (fastify-plugin). */
export const rawBody = fp(rawBodyPlugin);
