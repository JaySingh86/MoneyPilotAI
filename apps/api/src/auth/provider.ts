// The auth provider port (ADR-017). The API depends on this interface, never on Cognito directly, so
// tests plug in a fake issuer and a future provider change touches one file.
import { AppError } from "@mp/contracts";

/** A token that passed signature, issuer, client id, token use and expiry checks. */
export interface VerifiedToken {
  /** Provider user id (Cognito `sub`). Becomes `users.auth_subject`. */
  readonly subject: string;
  /** `email` claim from the pre-token-generation trigger; null when absent. */
  readonly email: string | null;
  /** True only when the `email_verified` claim is boolean true (or the string "true"). */
  readonly emailVerified: boolean;
  /** The `mfa_enabled` claim (enrolled, informational); null unless it is a boolean. */
  readonly mfaEnabled: boolean | null;
  /**
   * `mfa_verified_at` (epoch seconds, a number): when this session last completed a second-factor challenge
   * (ADR-018). Null when absent or not a positive integer. Step-up is decided by this claim alone.
   */
  readonly mfaVerifiedAt: number | null;
  /** `exp` (epoch seconds). */
  readonly expiresAt: number;
}

/** What `POST /me/bootstrap` may take from a token. */
export interface AuthUser {
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
}

export interface StepUpOptions {
  /**
   * Maximum age of the sign-in in seconds. Default 600 (10 minutes), the limit for destructive actions
   * (BACKEND_PLAN §6).
   */
  readonly maxAgeSeconds?: number;
}

export const STEP_UP_MAX_AGE_SECONDS = 600;

export interface AuthProvider {
  /** Verifies an access token. Throws `AppError("unauthorized", 401)` for any invalid token. */
  verifyToken(token: string): Promise<VerifiedToken>;
  /** The identity fields the API may mirror into `users`. */
  getUser(token: VerifiedToken): AuthUser;
  /**
   * Throws `AppError("mfa_required", 403)` unless `mfa_verified_at` is at most `maxAgeSeconds` old.
   * `mfa_enabled` and `auth_time` never satisfy it. Missing or malformed claims fail closed.
   */
  requireStepUp(token: VerifiedToken, options?: StepUpOptions): void;
}

export function unauthorized(detail: string): AppError {
  return new AppError("unauthorized", 401, detail);
}
