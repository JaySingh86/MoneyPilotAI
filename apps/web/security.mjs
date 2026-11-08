// Security headers and production environment checks for the web app. Plain ESM so that
// next.config.mjs (Node), middleware.ts (Edge) and the tests can all import it.

/**
 * @typedef {object} WebEnv
 * @property {string | undefined} [NEXT_PUBLIC_API_URL]
 * @property {string | undefined} [NEXT_PUBLIC_STORAGE_URL]
 * @property {string | undefined} [NEXT_PUBLIC_COGNITO_USER_POOL_ID]
 * @property {string | undefined} [NEXT_PUBLIC_COGNITO_CLIENT_ID]
 * @property {string | undefined} [NEXT_PUBLIC_COGNITO_REGION]
 * @property {string | undefined} [NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN]
 */

const DEFAULT_DEV_API_URL = "http://localhost:4000";
/** Local MinIO: the browser PUTs a CSV straight to the object store (WP-32). */
const DEFAULT_DEV_STORAGE_URL = "http://localhost:9000";

/** The API's origin, or null when the URL is missing or not a URL. */
export function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The Cognito endpoints Amplify Auth talks to, from the pool id and the optional hosted UI domain. */
export function cognitoOrigins(env) {
  const poolId = env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  if (!poolId) return [];
  const region = env.NEXT_PUBLIC_COGNITO_REGION || poolId.split("_")[0];
  const origins = [
    `https://cognito-idp.${region}.amazonaws.com`,
    `https://cognito-identity.${region}.amazonaws.com`,
  ];
  const domain = env.NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN;
  if (domain) origins.push(domain.startsWith("https://") ? domain : `https://${domain}`);
  return origins;
}

/**
 * The Content-Security-Policy for one response. `nonce` is generated per request by the middleware.
 * No `unsafe-eval` outside development (React's dev tools need it); styles allow inline because
 * React and next/font set style attributes.
 *
 * @param {{ nonce: string, dev: boolean, env: WebEnv }} options
 */
export function buildCsp({ nonce, dev, env }) {
  const api = originOf(env.NEXT_PUBLIC_API_URL) ?? (dev ? DEFAULT_DEV_API_URL : null);
  // The object store the presigned CSV upload goes to (Supabase Storage or MinIO), not our API.
  const configuredStorage = originOf(env.NEXT_PUBLIC_STORAGE_URL);
  const storage =
    (configuredStorage && (dev || configuredStorage.startsWith("https://")) ? configuredStorage : null) ??
    (dev ? DEFAULT_DEV_STORAGE_URL : null);
  const connect = ["'self'", ...(api ? [api] : []), ...(storage ? [storage] : []), ...cognitoOrigins(env)];
  const script = ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])];
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    // The mock API's service worker (development only).
    ...(dev ? ["worker-src 'self'"] : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Headers on every response, besides the CSP (which carries a per-request nonce). */
export const STATIC_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "X-Frame-Options", value: "DENY" },
];

/** The invite link carries a secret token in its URL: never send it as a Referer (the page also strips it). */
export const INVITE_HEADERS = [{ key: "Referrer-Policy", value: "no-referrer" }];

/**
 * Problems that must stop a production build or server: the API must be https and the Cognito pool
 * must be configured, otherwise the app would ship talking to localhost or unable to sign in.
 *
 * @param {WebEnv} env
 * @returns {string[]}
 */
export function productionEnvProblems(env) {
  const problems = [];
  const api = env.NEXT_PUBLIC_API_URL;
  if (!api) problems.push("NEXT_PUBLIC_API_URL is not set");
  else if (originOf(api) === null || new URL(api).protocol !== "https:") {
    problems.push("NEXT_PUBLIC_API_URL must be an https URL");
  }
  if (!env.NEXT_PUBLIC_COGNITO_USER_POOL_ID) problems.push("NEXT_PUBLIC_COGNITO_USER_POOL_ID is not set");
  if (!env.NEXT_PUBLIC_COGNITO_CLIENT_ID) problems.push("NEXT_PUBLIC_COGNITO_CLIENT_ID is not set");
  return problems;
}
