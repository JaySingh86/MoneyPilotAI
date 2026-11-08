// Dependencies of the auth module, resolved lazily (module registration must not do I/O, lib/module.ts).
// `index.ts` of the API calls `configureAuthRuntime` once at startup; tests pass their own.
import { AppError } from "@mp/contracts";
import type { GoTrueClient } from "../../auth/gotrue";

export interface AuthModuleConfig {
  /** The web app origin, for the CSRF origin check and post-login redirects. */
  webOrigin: string;
  /** This API's public base URL; Google's return trip lands on `<it>/v1/auth/google/callback`. */
  apiPublicUrl: string;
  /** Refresh-token cookie `Secure` flag (off only for http://localhost development). */
  cookieSecure: boolean;
  /**
   * `AUTH_COOKIE_SECRET`: key material for the Google state cookie signature (HKDF-derived). Not the Supabase
   * secret key. (The failure limiter's hash key is separate: random per process, never persisted.)
   */
  cookieSecret: string;
}

export interface AuthModuleRuntime {
  gotrue: GoTrueClient;
  config: AuthModuleConfig;
}

export type AuthRuntimeSource = () => AuthModuleRuntime;

let configured: AuthModuleRuntime | null = null;

export function configureAuthRuntime(runtime: AuthModuleRuntime): void {
  configured = runtime;
}

/** Where Supabase is not configured (local dev without a project) the auth routes answer 503, not crash. */
export function authRuntime(): AuthModuleRuntime {
  if (!configured) throw new AppError("internal_error", 503, "Sign-in is not configured on this server.");
  return configured;
}
