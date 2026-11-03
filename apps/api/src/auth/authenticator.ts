// Turns an `Authorization: Bearer <Cognito access token>` header into the request's user (ADR-017).
// Plugged into the request-context plugin as `authenticate`; its AppErrors are raised after rate limiting.
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { AppError } from "@mp/contracts";
import { users, type ApiDb } from "@mp/db";
import type { AuthenticatedUser, Authenticator } from "../plugins/request-context";
import { unauthorized, type AuthProvider, type StepUpOptions, type VerifiedToken } from "./provider";

const BEARER = /^Bearer ([\x21-\x7e]+)$/i;

const verifiedTokens = new WeakMap<AuthenticatedUser, VerifiedToken>();

export interface AuthenticatorDeps {
  provider: AuthProvider;
  db: ApiDb;
}

/**
 * No header: anonymous (routes then answer 401 through `requireUser`). A header that is not a single
 * Bearer token, or a token that does not verify: 401. A verified token for a user whose row is deleted:
 * 401. A verified token with no `users` row yet: `userId: null`, so only `POST /me/bootstrap` works.
 */
export function createAuthenticator(deps: AuthenticatorDeps): Authenticator {
  return async (request: FastifyRequest): Promise<AuthenticatedUser | null> => {
    const header = request.headers.authorization;
    if (header === undefined) return null;
    const match = BEARER.exec(header);
    if (!match?.[1]) throw unauthorized("Send the access token as: Authorization: Bearer <token>.");

    const token = await deps.provider.verifyToken(match[1]);
    const row = await deps.db.withHouseholdTx({ userId: null, authSubject: token.subject }, async (tx) => {
      const found = await tx
        .select({ id: users.id, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.authSubject, token.subject))
        .limit(1);
      return found[0];
    });
    if (row?.deletedAt) throw unauthorized("This account has been deleted.");

    const user: AuthenticatedUser = {
      userId: row?.id ?? null,
      authSubject: token.subject,
      claims: { ...token },
    };
    verifiedTokens.set(user, token);
    return user;
  };
}

/** The verified token behind this request. 401 when the request was not authenticated by a provider. */
export function verifiedTokenOf(request: FastifyRequest): VerifiedToken {
  const user = request.ctx.user;
  const token = user ? verifiedTokens.get(user) : undefined;
  if (!token) throw new AppError("unauthorized", 401, "Sign in to continue.");
  return token;
}

/** Step-up MFA (BACKEND_PLAN §6): call first in the handler of a step-up route (§8.2: leave, export, delete, email connect). */
export function requireStepUp(
  provider: AuthProvider,
  request: FastifyRequest,
  options?: StepUpOptions,
): void {
  provider.requireStepUp(verifiedTokenOf(request), options);
}
