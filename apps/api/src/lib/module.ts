import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Default mount point for module routes (BACKEND_PLAN §8.1 base URL). */
export const API_PREFIX = "/v1";

/** Webhooks stay at the root, unversioned (Q-032), and are hidden from the public OpenAPI document. */
export const WEBHOOKS_PREFIX = "/webhooks";

/**
 * One API module (ARCHITECTURE §3.1): a Fastify plugin whose routes use Zod schemas from
 * `@mp/contracts`. Registration must not do I/O, because `pnpm contracts:gen` builds the server without a
 * database to read the OpenAPI document. Reach dependencies (db, clients) inside handlers.
 *
 * Route recipe (copy `lib/example/example-routes.ts`; the server refuses to start when a rule is broken):
 * - Schemas: request and response Zod schemas from `@mp/contracts`. Money is `Cents`, dates `IsoDate`.
 * - Household routes: `/households/:hid/...` with `params: HouseholdParams` (a `:hid` route without a
 *   params schema fails at startup). DB access is `withHouseholdTx(dbContext(request), fn)`.
 * - Every POST/PUT/PATCH/DELETE sets `config.idempotency` (startup check):
 *   `"required"` on creates, `"optional"` on other writes, `"off"` on webhooks and on any route whose
 *   response carries a secret (OAuth URL with state, presigned URL, token), because stored responses are
 *   kept for 24 h. Bodies over 64 KiB are not stored; a replay returns status, Location and ETag.
 * - PATCH: `requireIfMatch(request)` → `assertVersion(expected, current)` inside the transaction, update
 *   `where version = expected`, then `setVersionTag(reply, newVersion)`.
 * - Limits: the global 600/min applies by default. Auth-sensitive routes set
 *   `config: { rateLimitGroup: "authSensitive" }` and share one 20/min budget. Ask (30/day) and exports
 *   (3/day) count today's `ai_runs` / `data_requests` in their services (Q-031).
 * - Errors: throw `AppError(code, status, detail)`; `detail` must not contain PII or amounts.
 * - Webhooks: module `prefix: WEBHOOKS_PREFIX`, `await scope.register(rawBody)`, every route
 *   `config: { rateLimit: false, idempotency: "off" }`; verify with `lib/webhooks` before anything else,
 *   then record in `webhook_events` and enqueue.
 */
export interface ApiModule {
  /** Unique module name, e.g. `identity`, `items`. Used as the OpenAPI tag. */
  readonly name: string;
  /** Mount prefix. Defaults to `/v1`; webhooks use `WEBHOOKS_PREFIX`. */
  readonly prefix?: string;
  readonly routes: FastifyPluginAsyncZod;
}

export function defineModule(module: ApiModule): ApiModule {
  return module;
}
