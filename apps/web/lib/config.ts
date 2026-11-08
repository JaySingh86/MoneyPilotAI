// Runtime configuration for the web app. Everything here is public (NEXT_PUBLIC_*): ids and URLs,
// never secrets (CLAUDE.md hard rule 12).
//
// Next inlines `process.env.NAME` only when it is written out literally, so each variable is read
// by name below and the helpers take plain values (which also makes them easy to test).

/**
 * Mock mode: MSW answers the API and a fake session is signed in, so `pnpm dev` works without a backend.
 * It is impossible to enable in production:
 * - `next.config.mjs` throws when NEXT_PUBLIC_MP_MOCK is set on anything but the dev server;
 * - {@link resolveMockMode} is false whenever NODE_ENV is "production", and Next inlines NODE_ENV,
 *   so in a production bundle `MOCK_MODE` is the constant `false` and the bundler drops every
 *   `if (MOCK_MODE) await import("…/mocks/…")` branch;
 * - {@link assertMockAllowed} throws if a production environment ever reports the flag.
 */
export function resolveMockMode(nodeEnv: string | undefined, flag: string | undefined): boolean {
  if (nodeEnv === "production") return false;
  return flag === "1";
}

/** Throws when mock mode was requested in a production environment. */
export function assertMockAllowed(nodeEnv: string | undefined, flag: string | undefined): void {
  if (nodeEnv === "production" && flag !== undefined) {
    throw new Error("Mock mode is not available in production builds.");
  }
}

assertMockAllowed(process.env.NODE_ENV, process.env.NEXT_PUBLIC_MP_MOCK);

export const MOCK_MODE: boolean = resolveMockMode(process.env.NODE_ENV, process.env.NEXT_PUBLIC_MP_MOCK);

export const API_BASE_URL: string = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Show "Continue with Google" (the project has Google sign-in enabled in Supabase, WP-33 runbook). */
export const GOOGLE_SIGN_IN: boolean = process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN === "1";
