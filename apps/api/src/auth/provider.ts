// The auth provider port (ADR-017, kept by ADR-020). The API depends on this interface, never on Supabase
// directly, so tests plug in a fake issuer and a future provider change touches one file.
import { AppError } from "@mp/contracts";

/** A token that passed signature, issuer, audience and expiry checks. */
export interface VerifiedToken {
  /** Provider user id (Supabase `sub`). Becomes `users.auth_subject`. */
  readonly subject: string;
  /** The `email` claim; null when absent. Not proof of a confirmed address: see `AuthProvider.getUser`. */
  readonly email: string | null;
  /**
   * Epoch seconds of the newest `totp` entry in `amr`, and only when the token's `aal` is `aal2`
   * (ADR-018). Null when absent or malformed. Step-up is decided by this value alone.
   */
  readonly mfaVerifiedAt: number | null;
  /** `exp` (epoch seconds). */
  readonly expiresAt: number;
  /**
   * The raw access token, for calls the API makes to the provider on the caller's behalf (user record, MFA).
   * Never log it or copy it into request context.
   */
  readonly accessToken: string;
}

/** What `POST /me/bootstrap` may take from the provider. */
export interface AuthUser {
  readonly subject: string;
  readonly email: string | null;
  /** True only when the provider's user record says the address is confirmed (`email_confirmed_at`). */
  readonly emailVerified: boolean;
  /** The user has a verified TOTP factor. */
  readonly mfaEnabled: boolean;
  /** The first name given at sign-up (provider user metadata, untrusted free text; may be null). */
  readonly firstName: string | null;
}

export interface StepUpOptions {
  /**
   * Maximum age of the second-factor proof in seconds. Default 600 (10 minutes), the limit for destructive
   * actions (BACKEND_PLAN §6).
   */
  readonly maxAgeSeconds?: number;
}

export const STEP_UP_MAX_AGE_SECONDS = 600;

export interface AuthProvider {
  /** Verifies an access token. Throws `AppError("unauthorized", 401)` for any invalid token. */
  verifyToken(token: string): Promise<VerifiedToken>;
  /**
   * The identity the API may mirror into `users`. Reads the provider's user record (the access token does
   * not carry `email_confirmed_at` or the MFA factors), so call it only where needed (bootstrap).
   */
  getUser(token: VerifiedToken): Promise<AuthUser>;
  /**
   * Throws `AppError("mfa_required", 403)` unless the token is `aal2` with a `totp` proof at most
   * `maxAgeSeconds` old. Missing or malformed values fail closed.
   */
  requireStepUp(token: VerifiedToken, options?: StepUpOptions): void;
}

export function unauthorized(detail: string): AppError {
  return new AppError("unauthorized", 401, detail);
}
