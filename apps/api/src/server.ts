// The API platform (WP-08): Fastify + Zod type provider, request context, rate limits, idempotency,
// problem+json errors, request logging without query strings, OpenAPI, and the module registry.
import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createLogger, type Logger } from "@mp/observability";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IF_MATCH_HEADER,
  REQUEST_ID_HEADER,
} from "@mp/contracts";
import { modules as registeredModules } from "./modules";
import { API_PREFIX, type ApiModule } from "./lib/module";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./lib/idempotency-store";
import { errors } from "./plugins/errors";
import { IDEMPOTENT_BODY_OMITTED_HEADER, idempotency } from "./plugins/idempotency";
import { openapi } from "./plugins/openapi";
import { rateLimits, type RateLimitOptions } from "./plugins/rate-limit";
import { requestContext, type Authenticator } from "./plugins/request-context";
import { requestLogging } from "./plugins/request-logging";

export type ApiServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface ServerOptions {
  /** Shared redacting logger. Default: a silent `api` logger (tests). */
  logger?: Logger;
  /** API modules. Default: the registry in `src/modules/index.ts`. */
  modules?: readonly ApiModule[];
  /** Credential verification (WP-05 plugs in the auth provider). Default: every request is anonymous. */
  authenticate?: Authenticator;
  /** Default: in-memory (single process). See the TODO in lib/idempotency-store.ts. */
  idempotencyStore?: IdempotencyStore;
  /** Clock in epoch ms for idempotency expiry (tests). */
  now?: () => number;
  rateLimit?: RateLimitOptions;
  /** Allowed browser origins (strict CORS: the web origin only). Empty: no CORS headers. */
  corsOrigins?: readonly string[];
  /** Proxy hops to trust for the client IP (1 behind the ALB). Default: none. */
  trustProxy?: boolean | number;
  /** Max JSON body size in bytes. Default 1 MiB. */
  bodyLimit?: number;
}

function trustProxy(
  setting: boolean | number | undefined,
): boolean | ((addr: string, hop: number) => boolean) {
  if (typeof setting !== "number") return setting ?? false;
  return (_addr, hop) => hop < setting;
}

const HealthResponse = z.object({ status: z.literal("ok") });

export function buildServer(options: ServerOptions = {}): ApiServer {
  const modules = options.modules ?? registeredModules;
  const names = new Set<string>();
  for (const m of modules) {
    if (names.has(m.name)) throw new Error(`Duplicate API module name: ${m.name}`);
    names.add(m.name);
  }

  const app = Fastify({
    loggerInstance: (options.logger ?? createLogger("api", "silent")) as FastifyBaseLogger,
    // Fastify's own request and error log lines include the full URL (so OAuth code/state) and raw error
    // messages; they are all off. plugins/request-logging.ts and plugins/errors.ts log safe lines instead.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    trustProxy: trustProxy(options.trustProxy),
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Order matters: context (auth) before rate limits (keyed per user) before idempotency (scoped per user).
  void app.register(requestContext, { authenticate: options.authenticate });
  void app.register(errors);
  void app.register(rateLimits, options.rateLimit ?? {});
  void app.register(idempotency, {
    store: options.idempotencyStore ?? new InMemoryIdempotencyStore(),
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(requestLogging);
  void app.register(cors, {
    origin: options.corsOrigins && options.corsOrigins.length > 0 ? [...options.corsOrigins] : false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type", IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER],
    exposedHeaders: [
      REQUEST_ID_HEADER,
      "etag",
      "location",
      "retry-after",
      IDEMPOTENT_REPLAYED_HEADER,
      IDEMPOTENT_BODY_OMITTED_HEADER,
    ],
    maxAge: 600,
  });
  void app.register(openapi);

  // Routes are registered after the platform plugins so their onRoute hooks (rate limits, problem
  // responses, OpenAPI) see every route.
  void app.register(async (root) => {
    root.get(
      "/health",
      {
        schema: { tags: ["system"], security: [], response: { 200: HealthResponse } },
        config: { rateLimit: false },
      },
      async () => ({ status: "ok" as const }),
    );

    for (const module of modules) {
      await root.register(
        async (scope) => {
          scope.addHook("onRoute", (route) => {
            if (route.schema && !route.schema.tags) route.schema.tags = [module.name];
          });
          await scope.register(module.routes);
        },
        { prefix: module.prefix ?? API_PREFIX },
      );
    }
  });

  return app;
}
