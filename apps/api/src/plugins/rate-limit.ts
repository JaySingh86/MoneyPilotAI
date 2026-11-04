// Per-user rate limits (BACKEND_PLAN §8.1). 429 problem+json `rate_limited` with Retry-After.
//
// Per-minute limits live in memory per API instance (Q-031). The daily caps are NOT enforced here:
// - Ask 30/day: TODO(WP-28) count today's `ai_runs` rows for the user in the Ask service.
// - Exports 3/day: TODO(WP-24) count today's `data_requests` rows in the export service.
// Those counts hold across instances and restarts, which an in-memory limiter cannot.
import type { FastifyPluginAsync, FastifyRequest, onRequestHookHandler } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { AppError } from "@mp/contracts";

/** Platform limits. Routes without config get `overall`. */
export const RATE_LIMITS = {
  /** 600 requests per minute per user (the global default). */
  overall: { max: 600, timeWindow: "1 minute" },
  /** Auth-sensitive endpoints (invites, email connect, step-up flows): 20 per minute, shared by all of them. */
  authSensitive: { max: 20, timeWindow: "1 minute" },
  /** Engine calculations (plan, what-if, calendar): 60 per minute per user, shared (WP-12). */
  compute: { max: 60, timeWindow: "1 minute" },
  /** CSV import calls (create, process, mapping): 10 per minute per user, shared (WP-16). */
  imports: { max: 10, timeWindow: "1 minute" },
} as const;

/**
 * Named budgets shared across routes: `config: { rateLimitGroup: "authSensitive" }`. Every route in a
 * group draws from ONE per-user counter, so spreading calls over several endpoints does not multiply it.
 */
export const RATE_LIMIT_GROUPS = {
  authSensitive: RATE_LIMITS.authSensitive,
  compute: RATE_LIMITS.compute,
  imports: RATE_LIMITS.imports,
} as const;
export type RateLimitGroup = keyof typeof RATE_LIMIT_GROUPS;

declare module "fastify" {
  interface FastifyContextConfig {
    rateLimitGroup?: RateLimitGroup;
  }
}

/** Signed-in callers are limited per user; anonymous ones per client IP. */
export function rateLimitKey(request: FastifyRequest): string {
  const user = request.ctx?.user;
  return user ? `u:${user.authSubject}` : `ip:${request.ip}`;
}

export interface RateLimitOptions {
  /** Override the global per-minute limit (tests). */
  max?: number;
  timeWindow?: string | number;
  /** Override named group budgets (tests that make many calls in one group). */
  groups?: Partial<Record<RateLimitGroup, { max: number; timeWindow: string | number }>>;
}

const rateLimitPlugin: FastifyPluginAsync<RateLimitOptions> = async (app, opts) => {
  // One limiter (one store) per group, created on first use and reused by every route in the group.
  const shared = new Map<RateLimitGroup, onRequestHookHandler>();
  const groupLimiter = (group: RateLimitGroup): onRequestHookHandler => {
    let hook = shared.get(group);
    if (!hook) {
      hook = app.rateLimit({ ...RATE_LIMIT_GROUPS[group], ...opts.groups?.[group] }) as onRequestHookHandler;
      shared.set(group, hook);
    }
    return hook;
  };

  // Registered before @fastify/rate-limit so this runs first and turns its per-route limiter off.
  app.addHook("onRoute", (route) => {
    const group = route.config?.rateLimitGroup;
    if (group === undefined) return;
    if (!Object.hasOwn(RATE_LIMIT_GROUPS, group)) throw new Error(`Unknown rate-limit group: ${group}`);
    route.config = { ...route.config, rateLimit: false };
    const hook = groupLimiter(group);
    const existing = route.onRequest;
    route.onRequest =
      existing === undefined ? [hook] : [...(Array.isArray(existing) ? existing : [existing]), hook];
  });

  await app.register(rateLimit, {
    global: true,
    max: opts.max ?? RATE_LIMITS.overall.max,
    timeWindow: opts.timeWindow ?? RATE_LIMITS.overall.timeWindow,
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (_request, context) => {
      const retryAfter = Math.max(1, Math.ceil(context.ttl / 1000));
      return new AppError("rate_limited", 429, `Too many requests. Try again in ${retryAfter} seconds.`, {
        headers: { "retry-after": String(retryAfter) },
      });
    },
  });
};

export const rateLimits = fp(rateLimitPlugin, {
  name: "mp-rate-limit",
  dependencies: ["mp-request-context"],
});
