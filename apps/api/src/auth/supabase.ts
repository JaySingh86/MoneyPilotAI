// Supabase Auth implementation of the auth provider (ADR-020, BACKEND_PLAN §6).
//
// The API accepts the Supabase ACCESS token. `jose` checks the signature against the project's public JWKS
// (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, asymmetric keys only: a legacy HS256 shared secret is
// refused), the issuer `<SUPABASE_URL>/auth/v1`, the audience `authenticated`, and expiry with a 60 s skew.
//
// What Supabase puts in the access token (and what it does not):
//   - `sub`, `email`, `aal` (aal1 | aal2), `amr` ([{ method, timestamp }]), `session_id`, `is_anonymous`,
//     `app_metadata`, `user_metadata`.
//   - NOT `email_confirmed_at` and NOT the MFA factors. `user_metadata` (with `email_verified`) is editable by
//     the user, so it is never trusted. The confirmed address and the factor list come from the user record
//     (`getUser`, one call, used by bootstrap only).
//
// Step-up (ADR-018): `aal === "aal2"` and an `amr` entry with method `totp` whose timestamp is at most 10
// minutes old. A password or Google sign-in never satisfies it.
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { AppError } from "@mp/contracts";
import type { GoTrueClient } from "./gotrue";
import {
  STEP_UP_MAX_AGE_SECONDS,
  unauthorized,
  type AuthProvider,
  type AuthUser,
  type StepUpOptions,
  type VerifiedToken,
} from "./provider";

export interface SupabaseProviderConfig {
  /** `https://<ref>.supabase.co`. */
  url: string;
  /** Reads the user record for `getUser`. */
  gotrue: GoTrueClient;
  /** Replaces the remote JWKS (tests serve a local one). Production fetches it over HTTPS and caches it. */
  getKey?: JWTVerifyGetKey;
  /** Clock skew tolerated on exp / nbf, in seconds. Default 60 (ADR-020). */
  graceSeconds?: number;
}

export interface SupabaseProviderOptions {
  /** Clock in epoch ms for the step-up age check (tests). */
  now?: () => number;
}

/** Bearer tokens longer than this are refused before any parsing (a Supabase access token is ~1 KB). */
const MAX_TOKEN_LENGTH = 8 * 1024;
const STEP_UP_FUTURE_SKEW_SECONDS = 60;
/** Supabase signs with ES256 (default), RS256 or EdDSA. HS256 and `none` are never accepted. */
const ALGORITHMS = ["ES256", "RS256", "EdDSA"];

const Claims = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(254).optional().catch(undefined),
  aal: z.string().optional().catch(undefined),
  amr: z
    .array(z.object({ method: z.unknown(), timestamp: z.unknown() }).passthrough())
    .optional()
    .catch(undefined),
  role: z.string().optional().catch(undefined),
  is_anonymous: z.boolean().optional().catch(undefined),
  exp: z.number().int(),
});

/** The newest `totp` proof in `amr`, only for an aal2 token. Anything malformed is "no proof". */
export function totpProofAt(
  aal: string | undefined,
  amr: readonly { method: unknown; timestamp: unknown }[] | undefined,
): number | null {
  if (aal !== "aal2" || !amr) return null;
  let newest: number | null = null;
  for (const entry of amr) {
    if (entry.method !== "totp") continue;
    const ts = entry.timestamp;
    if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) continue;
    if (newest === null || ts > newest) newest = ts;
  }
  return newest;
}

export function createSupabaseProvider(
  config: SupabaseProviderConfig,
  options: SupabaseProviderOptions = {},
): AuthProvider {
  const now = options.now ?? Date.now;
  const base = config.url.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const getKey: JWTVerifyGetKey =
    config.getKey ??
    createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000 });

  return {
    async verifyToken(token: string): Promise<VerifiedToken> {
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        throw unauthorized("The access token is invalid.");
      }
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer,
          audience: "authenticated",
          algorithms: ALGORITHMS,
          clockTolerance: config.graceSeconds ?? 60,
        }));
      } catch (err) {
        // The reason (wrong issuer, audience, bad signature, ...) is deliberately not reported.
        // Only expiry is, so a client knows to refresh instead of signing in again.
        throw unauthorized(
          err instanceof joseErrors.JWTExpired
            ? "The access token has expired."
            : "The access token is invalid.",
        );
      }
      const claims = Claims.safeParse(payload);
      // Anonymous users have no email; the `service_role` and `anon` keys are not user sessions.
      if (!claims.success || claims.data.is_anonymous === true || claims.data.role !== "authenticated") {
        throw unauthorized("The access token is invalid.");
      }
      return {
        subject: claims.data.sub,
        email: claims.data.email ?? null,
        mfaVerifiedAt: totpProofAt(claims.data.aal, claims.data.amr),
        expiresAt: claims.data.exp,
        accessToken: token,
      };
    },

    async getUser(token: VerifiedToken): Promise<AuthUser> {
      const user = await config.gotrue.getUser(token.accessToken).catch(() => {
        throw new AppError("internal_error", 503, "Sign-in is temporarily unavailable. Try again shortly.");
      });
      // The record must belong to the verified token (defence in depth; the token is what proved identity).
      if (user.id !== token.subject) throw unauthorized("The access token is invalid.");
      return {
        subject: token.subject,
        email: user.email,
        emailVerified: user.emailConfirmedAt !== null,
        mfaEnabled: user.factors.some((f) => f.type === "totp" && f.status === "verified"),
        firstName: user.firstName,
      };
    },

    requireStepUp(token: VerifiedToken, stepUp: StepUpOptions = {}): void {
      // ADR-018: only a recent `totp` proof counts. An enrolled factor (mfaEnabled) and a password or
      // Google sign-in (aal1) never satisfy step-up.
      const age = token.mfaVerifiedAt === null ? null : Math.floor(now() / 1000) - token.mfaVerifiedAt;
      const maxAge = stepUp.maxAgeSeconds ?? STEP_UP_MAX_AGE_SECONDS;
      if (age === null || age > maxAge || age < -STEP_UP_FUTURE_SKEW_SECONDS) {
        throw new AppError("mfa_required", 403, "Confirm with your authenticator app, then retry.");
      }
    },
  };
}
