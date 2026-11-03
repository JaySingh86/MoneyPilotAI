// AWS Cognito implementation of the auth provider (ADR-017, BACKEND_PLAN §6).
//
// The API accepts the Cognito ACCESS token. `aws-jwt-verify` checks the signature against the user
// pool's JWKS (RS256 only), the issuer, `token_use = access`, the app client id, and expiry with a 60 s
// clock skew. A pre-token-generation trigger (created in WP-09) adds `email`, `email_verified`,
// `mfa_enabled` and `mfa_verified_at` (ADR-018); this file only reads them.
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { JwtExpiredError } from "aws-jwt-verify/error";
import type { JwksCache } from "aws-jwt-verify/jwk";
import { z } from "zod";
import { AppError } from "@mp/contracts";
import {
  STEP_UP_MAX_AGE_SECONDS,
  unauthorized,
  type AuthProvider,
  type AuthUser,
  type StepUpOptions,
  type VerifiedToken,
} from "./provider";

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  /** The app client id the web and mobile apps sign in with. Tokens for any other client are refused. */
  clientId: string;
  /** Clock skew tolerated on exp / nbf. Default 60 (ADR-017). */
  graceSeconds?: number;
  /** Replaces the JWKS cache (tests serve a local JWKS). Production fetches from Cognito over HTTPS. */
  jwksCache?: JwksCache;
}

export interface CognitoProviderOptions {
  /** Clock in epoch ms for the step-up age check (tests). */
  now?: () => number;
}

/** Bearer tokens longer than this are refused before any parsing (a Cognito access token is ~1 KB). */
const MAX_TOKEN_LENGTH = 8 * 1024;
const STEP_UP_FUTURE_SKEW_SECONDS = 60;

/** `email_verified` only: tolerant of the string form some token versions emit. Anything else is "not set". */
const BoolClaim = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true")
  .optional()
  .catch(undefined);

const Claims = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(254).optional().catch(undefined),
  email_verified: BoolClaim,
  // Strict: only a JSON boolean counts (no string tolerance), and only a JSON number for the timestamp.
  mfa_enabled: z.boolean().optional().catch(undefined),
  mfa_verified_at: z.number().int().positive().optional().catch(undefined),
  exp: z.number().int(),
});

export function createCognitoProvider(
  config: CognitoConfig,
  options: CognitoProviderOptions = {},
): AuthProvider {
  const now = options.now ?? Date.now;
  const verifier = CognitoJwtVerifier.create(
    {
      userPoolId: config.userPoolId,
      tokenUse: "access",
      clientId: config.clientId,
      graceSeconds: config.graceSeconds ?? 60,
    },
    config.jwksCache ? { jwksCache: config.jwksCache } : undefined,
  );

  return {
    async verifyToken(token: string): Promise<VerifiedToken> {
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        throw unauthorized("The access token is invalid.");
      }
      let payload: unknown;
      try {
        payload = await verifier.verify(token);
      } catch (err) {
        // The reason (wrong issuer, wrong client, bad signature, ...) is deliberately not reported.
        // Only expiry is, so a client knows to refresh instead of signing in again.
        throw unauthorized(
          err instanceof JwtExpiredError ? "The access token has expired." : "The access token is invalid.",
        );
      }
      const claims = Claims.safeParse(payload);
      if (!claims.success) throw unauthorized("The access token is invalid.");
      return {
        subject: claims.data.sub,
        email: claims.data.email ?? null,
        emailVerified: claims.data.email_verified === true,
        mfaEnabled: claims.data.mfa_enabled ?? null,
        mfaVerifiedAt: claims.data.mfa_verified_at ?? null,
        expiresAt: claims.data.exp,
      };
    },

    getUser(token: VerifiedToken): AuthUser {
      return {
        subject: token.subject,
        email: token.email,
        emailVerified: token.emailVerified,
        mfaEnabled: token.mfaEnabled === true,
      };
    },

    requireStepUp(token: VerifiedToken, stepUp: StepUpOptions = {}): void {
      // ADR-018: only `mfa_verified_at` counts. `mfa_enabled` (enrolled) and `auth_time` (a password
      // sign-in) never satisfy step-up.
      const age = token.mfaVerifiedAt === null ? null : Math.floor(now() / 1000) - token.mfaVerifiedAt;
      const maxAge = stepUp.maxAgeSeconds ?? STEP_UP_MAX_AGE_SECONDS;
      if (age === null || age > maxAge || age < -STEP_UP_FUTURE_SKEW_SECONDS) {
        throw new AppError("mfa_required", 403, "Confirm with your authenticator app, then retry.");
      }
    },
  };
}
