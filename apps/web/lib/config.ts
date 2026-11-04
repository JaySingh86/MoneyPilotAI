// Runtime configuration for the web app. Everything here is public (NEXT_PUBLIC_*): ids and URLs,
// never secrets (CLAUDE.md hard rule 12).
//
// Next inlines `process.env.NAME` only when it is written out literally, so each variable is read
// by name below and the helpers take plain values (which also makes them easy to test).

/**
 * Mock mode: MSW answers the API and a fake session is signed in, so `pnpm dev` works without AWS.
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

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  /** Hosted UI domain, only for "Continue with Google" (federation). */
  oauthDomain: string | null;
}

/** The Cognito user pool the web client signs in to, or null when it is not configured. */
export function resolveCognitoConfig(values: {
  region?: string | undefined;
  userPoolId?: string | undefined;
  userPoolClientId?: string | undefined;
  oauthDomain?: string | undefined;
}): CognitoConfig | null {
  if (!values.userPoolId || !values.userPoolClientId) return null;
  return {
    region: values.region || values.userPoolId.split("_")[0] || "us-east-1",
    userPoolId: values.userPoolId,
    userPoolClientId: values.userPoolClientId,
    oauthDomain: values.oauthDomain || null,
  };
}

export const COGNITO: CognitoConfig | null = resolveCognitoConfig({
  region: process.env.NEXT_PUBLIC_COGNITO_REGION,
  userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
  userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  oauthDomain: process.env.NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN,
});
