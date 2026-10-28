// Idempotency-Key for writes (BACKEND_PLAN §8.1, ARCHITECTURE §5). A repeat within 24 h with the same key
// and the same request replays the stored response; the same key with a different request is 422.
import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AppError, IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, IdempotencyKey } from "@mp/contracts";
import {
  MAX_STORED_BODY_BYTES,
  type IdempotencyScope,
  type IdempotencyStore,
  type StoredResponse,
} from "../lib/idempotency-store";

/** Set on a replay whose original body was over the size cap and was not stored. */
export const IDEMPOTENT_BODY_OMITTED_HEADER = "idempotent-body-omitted";

/**
 * Per-route `config.idempotency`:
 * Every POST, PUT, PATCH and DELETE route must set it (checked at startup):
 * - `required`: POSTs that create things. A missing key is 400 `validation_failed`.
 * - `optional`: honored when sent.
 * - `off`: never stored. Use it for webhooks (they dedupe on `webhook_events`) and for any route whose
 *   response carries a secret (an OAuth URL with state, a presigned URL, a token): stored responses are
 *   kept for 24 h.
 */
export type IdempotencyMode = "required" | "optional" | "off";

declare module "fastify" {
  interface FastifyContextConfig {
    idempotency?: IdempotencyMode;
  }
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REPLAYED_HEADERS = ["content-type", "location", "etag"];

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` fingerprint the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 over method, URL and canonical body. Stored as `request_hash`. */
export function requestFingerprint(request: Pick<FastifyRequest, "method" | "url" | "body">): string {
  return createHash("sha256")
    .update(`${request.method}\n${request.url}\n${canonicalJson(request.body)}`)
    .digest("hex");
}

function headerError(message: string): AppError {
  return new AppError("validation_failed", 400, "The Idempotency-Key header is invalid.", {
    fields: [{ in: "headers", path: "Idempotency-Key", message }],
  });
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /** Clock in epoch ms (tests). */
  now?: () => number;
}

function routeMethods(method: string | string[]): string[] {
  return (Array.isArray(method) ? method : [method]).map((m) => m.toUpperCase());
}

const idempotencyPlugin: FastifyPluginAsync<IdempotencyOptions> = async (app, opts) => {
  const { store } = opts;

  // Every write route states its mode, so nobody forgets `required` on a create (fails at startup).
  app.addHook("onRoute", (route) => {
    const writes = routeMethods(route.method).filter((m) => WRITE_METHODS.has(m));
    const mode = (route.config as { idempotency?: unknown } | undefined)?.idempotency;
    if (writes.length > 0 && mode !== "required" && mode !== "optional" && mode !== "off") {
      throw new Error(
        `${writes.join(",")} ${route.url}: set config.idempotency to "required", "optional" or "off".`,
      );
    }
  });
  const now = opts.now ?? Date.now;
  const owned = new WeakMap<FastifyRequest, IdempotencyScope>();

  async function releaseIfOwned(request: FastifyRequest): Promise<void> {
    const scope = owned.get(request);
    if (!scope) return;
    owned.delete(request);
    await store.release(scope);
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!WRITE_METHODS.has(request.method)) return;
    const mode = request.routeOptions.config.idempotency ?? "optional";
    if (mode === "off") return;

    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (raw === undefined) {
      if (mode === "required") throw headerError("Required for this request");
      return;
    }
    const parsed = IdempotencyKey.safeParse(raw);
    if (!parsed.success) throw headerError("Use 1-255 visible ASCII characters, e.g. a UUID");

    // Keys are stored per user. Anonymous writes (none in the MVP besides webhooks) are not deduplicated.
    const user = request.ctx.user;
    if (!user) {
      if (mode === "required") throw new AppError("unauthorized", 401, "Sign in to continue.");
      return;
    }
    // Before bootstrap there is no users row to scope the key to; bootstrap itself is an upsert.
    if (user.userId === null) return;

    const scope: IdempotencyScope = { userId: user.userId, key: parsed.data };
    const result = await store.begin(scope, requestFingerprint(request), now());
    switch (result.kind) {
      case "started":
        owned.set(request, scope);
        return;
      case "replay": {
        const replay = reply
          .code(result.response.statusCode)
          .headers(result.response.headers)
          .header(IDEMPOTENT_REPLAYED_HEADER, "true");
        if (result.response.bodyOmitted) replay.header(IDEMPOTENT_BODY_OMITTED_HEADER, "true");
        return replay.send(result.response.body ?? undefined);
      }
      case "mismatch":
        throw new AppError(
          "idempotency_key_reused",
          422,
          "This Idempotency-Key was already used for a different request.",
        );
      case "in_progress":
        throw new AppError("conflict", 409, "A request with this Idempotency-Key is still in progress.");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const scope = owned.get(request);
    if (!scope) return payload;
    const body =
      payload === null || payload === undefined
        ? null
        : typeof payload === "string"
          ? payload
          : Buffer.isBuffer(payload)
            ? payload.toString("utf8")
            : undefined;
    if (reply.statusCode >= 400 || body === undefined) {
      // Only successful responses are stored. Errors depend on state that can change (step-up MFA, plan,
      // a partner's edit, a server fault), so the client may fix the cause and retry with the same key.
      await releaseIfOwned(request);
      return payload;
    }
    owned.delete(request);
    // Large bodies are not kept: replay gives the status, Location and ETag so the client can re-read.
    const tooLarge = body !== null && Buffer.byteLength(body, "utf8") > MAX_STORED_BODY_BYTES;
    const headers: Record<string, string> = {};
    for (const name of tooLarge ? ["location", "etag"] : REPLAYED_HEADERS) {
      const value = reply.getHeader(name);
      if (value !== undefined) headers[name] = String(value);
    }
    const response: StoredResponse = tooLarge
      ? { statusCode: reply.statusCode, headers, body: null, bodyOmitted: true }
      : { statusCode: reply.statusCode, headers, body };
    await store.complete(scope, response);
    return payload;
  });

  // A request that never reached onSend (client went away) must not hold its key for 24 h.
  app.addHook("onRequestAbort", releaseIfOwned);
  app.addHook("onResponse", releaseIfOwned);
};

export const idempotency = fp(idempotencyPlugin, {
  name: "mp-idempotency",
  dependencies: ["mp-request-context"],
});
