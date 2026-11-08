// Request context (ARCHITECTURE §5 Tenancy): who is calling and which household the request is about.
// Built only from a verified token and the route params, never from the body. Feeds withHouseholdTx.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AppError, isAppError, REQUEST_ID_HEADER, Uuid } from "@mp/contracts";
import type { ApiContext } from "@mp/db";

/** The caller, as established by the auth provider (WP-05, ADR-017). */
export interface AuthenticatedUser {
  /** `users.id`; null until `POST /v1/me/bootstrap` creates the row. */
  readonly userId: string | null;
  /** Verified auth-provider subject (Cognito `sub`). */
  readonly authSubject: string;
  /** Verified token claims the auth layer wants to keep, e.g. for step-up checks. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Verifies the request's credentials. Returns null when the request carries none. Throws an `AppError`
 * (typically `unauthorized`) for bad credentials; that error is raised after rate limiting, so token
 * guessing is limited per IP.
 */
export type Authenticator = (request: FastifyRequest) => Promise<AuthenticatedUser | null>;

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * The route authenticates its caller itself (a webhook with a provider token in `Authorization`), so the Cognito
     * check is skipped: such a header must not be taken for a user's access token.
     */
    skipUserAuth?: boolean;
  }
}

export interface RequestContext {
  readonly requestId: string;
  user: AuthenticatedUser | null;
  /** From the `:hid` route param once params are validated. Membership is enforced by RLS. */
  householdId: string | null;
  /** Deferred credential error, thrown in preValidation (after rate limiting). */
  authError: AppError | null;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

export interface RequestContextOptions {
  authenticate?: Authenticator;
}

const anonymous: Authenticator = async () => null;

const requestContextPlugin: FastifyPluginAsync<RequestContextOptions> = async (app, opts) => {
  const authenticate = opts.authenticate ?? anonymous;
  app.decorateRequest("ctx", null as unknown as RequestContext);

  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    request.ctx = { requestId: request.id, user: null, householdId: null, authError: null };
    try {
      request.ctx.user = await authenticate(request);
    } catch (err) {
      if (!isAppError(err)) throw err;
      request.ctx.authError = err;
    }
  });

  app.addHook("preValidation", async (request) => {
    if (request.ctx.authError) throw request.ctx.authError;
  });

  // A household route must validate its params (use `HouseholdParams` from @mp/contracts). Fail at startup.
  app.addHook("onRoute", (route) => {
    if (HID_SEGMENT.test(route.url) && !route.schema?.params) {
      throw new Error(`${route.url}: a route with :hid needs a params schema (HouseholdParams).`);
    }
  });

  app.addHook("preHandler", async (request) => {
    const params = request.params as Record<string, unknown> | undefined;
    if (!params || params.hid === undefined) return;
    // Checked here too, so a looser route schema can never put a non-UUID into the DB context.
    if (typeof params.hid !== "string" || !Uuid.safeParse(params.hid).success) {
      throw new AppError("validation_failed", 400, "The household id is invalid.", {
        fields: [{ in: "params", path: "hid", message: "Expected a UUID" }],
      });
    }
    request.ctx.householdId = params.hid;
  });
};

const HID_SEGMENT = /\/:hid(?=\/|$|\()/;

export const requestContext = fp(requestContextPlugin, { name: "mp-request-context" });

/** The signed-in caller, or 401 `unauthorized`. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.ctx.user;
  if (!user) throw new AppError("unauthorized", 401, "Sign in to continue.");
  return user;
}

/** The signed-in caller with a `users` row, or 401 / 403 (bootstrap first). */
export function requireUserId(request: FastifyRequest): string {
  const user = requireUser(request);
  if (user.userId === null) throw new AppError("forbidden", 403, "Call POST /v1/me/bootstrap first.");
  return user.userId;
}

/** The `withHouseholdTx` context for this request (`createApiDb().withHouseholdTx(dbContext(req), fn)`). */
export function dbContext(request: FastifyRequest): ApiContext {
  const user = requireUser(request);
  return { userId: user.userId, authSubject: user.authSubject, householdId: request.ctx.householdId };
}
