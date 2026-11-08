// The cookie that ties an OAuth round trip to the browser that started it (login CSRF / consent phishing). `start`
// sets it with a random nonce (its hash is stored with the state); the callback requires the same nonce and clears it.
// HttpOnly so a script cannot read it, SameSite=Lax so it comes back on the provider's top-level redirect and not on
// cross-site subrequests, path-scoped to the one callback, ten minutes like the state. Secure everywhere except on
// localhost, where there is no TLS.
import { createHash, randomBytes } from "node:crypto";
import type { EmailProviderId } from "@mp/contracts";

export const COOKIE_MAX_AGE_SECONDS = 10 * 60;

export const oauthCookieName = (provider: EmailProviderId) => `mp_email_oauth_${provider}`;
export const callbackPath = (provider: EmailProviderId) => `/v1/email-connections/${provider}/callback`;

export function newBrowserNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores in place of the nonce. */
export function hashNonce(nonce: string): Buffer {
  return createHash("sha256").update(nonce, "utf8").digest();
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

export function setCookie(provider: EmailProviderId, nonce: string, hostname: string): string {
  return [
    `${oauthCookieName(provider)}=${nonce}`,
    `Path=${callbackPath(provider)}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isLocalhost(hostname) ? [] : ["Secure"]),
  ].join("; ");
}

export function clearCookie(provider: EmailProviderId, hostname: string): string {
  return [
    `${oauthCookieName(provider)}=`,
    `Path=${callbackPath(provider)}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(isLocalhost(hostname) ? [] : ["Secure"]),
  ].join("; ");
}

/** The value of one cookie from a `Cookie` header, or undefined. Only the shapes we set (base64url) are accepted. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  return undefined;
}
