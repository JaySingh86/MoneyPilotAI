// Supabase Auth settings from the environment (ADR-020). In production a missing or inconsistent setting is a
// startup failure, never a silent "refuse every token": the caller exits. Elsewhere missing settings mean
// "sign-in not configured" (null), so local dev without a project still serves anonymous routes.
import { randomBytes } from "node:crypto";

export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
}

export interface AuthEnv {
  NODE_ENV?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  SUPABASE_SECRET_KEY?: string | undefined;
  AUTH_COOKIE_SECRET?: string | undefined;
  WEB_ORIGIN?: string | undefined;
  API_PUBLIC_URL?: string | undefined;
  API_PORT?: string | undefined;
}

export interface SupabaseAuthConfig {
  /** `https://<ref>.supabase.co`, no trailing slash. */
  url: string;
  publishableKey: string;
  secretKey: string;
  /** The web app origin: CSRF origin check, post-login redirects. */
  webOrigin: string;
  /** This API's public base URL (no trailing slash): Google's return trip lands on `<it>/v1/auth/google/callback`. */
  apiPublicUrl: string;
  /**
   * Signs the Google state cookie (32+ random bytes, base64). Required in production. Elsewhere a missing value
   * becomes a random per-process secret: in-flight Google sign-ins just fail across a restart.
   */
  cookieSecret: string;
  /** Refresh-token cookie `Secure` flag: on everywhere except plain-http localhost development. */
  cookieSecure: boolean;
}

function parseOrigin(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError(`${name} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AuthConfigError(`${name} must be an http(s) URL.`);
  }
  return url;
}

export function loadSupabaseAuthConfig(env: AuthEnv): SupabaseAuthConfig | null {
  const production = env.NODE_ENV === "production";
  const {
    SUPABASE_URL: rawUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
  } = env;
  if (!rawUrl || !publishableKey || !secretKey) {
    if (production) {
      throw new AuthConfigError(
        "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are required in production.",
      );
    }
    return null;
  }
  const url = parseOrigin("SUPABASE_URL", rawUrl);
  if (production && url.protocol !== "https:") {
    throw new AuthConfigError("SUPABASE_URL must be https in production.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new AuthConfigError("SUPABASE_URL must be the project origin only (no path).");
  }
  if (production && !env.WEB_ORIGIN) throw new AuthConfigError("WEB_ORIGIN is required in production.");
  if (production && !env.API_PUBLIC_URL)
    throw new AuthConfigError("API_PUBLIC_URL is required in production.");
  const web = parseOrigin("WEB_ORIGIN", env.WEB_ORIGIN ?? "http://localhost:3100");
  const api = parseOrigin(
    "API_PUBLIC_URL",
    env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT ?? "4000"}`,
  );
  if (production && (web.protocol !== "https:" || api.protocol !== "https:")) {
    throw new AuthConfigError("WEB_ORIGIN and API_PUBLIC_URL must be https in production.");
  }
  const rawSecret = env.AUTH_COOKIE_SECRET;
  if (production && !rawSecret) throw new AuthConfigError("AUTH_COOKIE_SECRET is required in production.");
  if (rawSecret !== undefined && rawSecret !== "" && Buffer.from(rawSecret, "base64").length < 32) {
    throw new AuthConfigError("AUTH_COOKIE_SECRET must be at least 32 random bytes, base64 encoded.");
  }
  const localDev = !production && web.protocol === "http:" && web.hostname === "localhost";
  return {
    url: url.origin,
    publishableKey,
    secretKey,
    cookieSecret: rawSecret ? rawSecret : randomBytes(32).toString("base64"),
    webOrigin: web.origin,
    apiPublicUrl: api.origin + api.pathname.replace(/\/+$/, ""),
    cookieSecure: !localDev,
  };
}
