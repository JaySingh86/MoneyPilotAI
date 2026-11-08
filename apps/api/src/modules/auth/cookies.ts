// Cookies for the auth routes, without a cookie dependency: the refresh token (web) and the short-lived,
// signed Google PKCE state. Values are never logged.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const REFRESH_COOKIE = "mp_rt";
const OAUTH_COOKIE = "mp_oauth";

/**
 * Where the browser would send the cookie over https, the `__Secure-` prefix makes it refuse the cookie unless it
 * is Secure, and stops a sibling subdomain from planting one over plain http.
 */
export const refreshCookieName = (secure: boolean): string =>
  secure ? `__Secure-${REFRESH_COOKIE}` : REFRESH_COOKIE;
export const oauthCookieName = (secure: boolean): string =>
  secure ? `__Secure-${OAUTH_COOKIE}` : OAUTH_COOKIE;
/** The refresh cookie is only ever sent to the auth routes. */
export const REFRESH_COOKIE_PATH = "/v1/auth";
export const OAUTH_COOKIE_PATH = "/v1/auth/google";
const REFRESH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_MAX_AGE_SECONDS = 600;

/**
 * The first cookie with this name. Browsers list the most specific path first, so a same-named cookie planted
 * on a parent domain (listed later) never wins over the one this API set on `/v1/auth`.
 */
export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function serialize(
  name: string,
  value: string,
  options: { path: string; maxAge: number; secure: boolean },
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** Appends one Set-Cookie header (several cookies can be set on one response). */
function appendSetCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  const list = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
  void reply.header("set-cookie", [...list, cookie]);
}

export function setRefreshCookie(reply: FastifyReply, token: string, secure: boolean): void {
  appendSetCookie(
    reply,
    serialize(refreshCookieName(secure), token, {
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_MAX_AGE_SECONDS,
      secure,
    }),
  );
}

export function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  appendSetCookie(
    reply,
    serialize(refreshCookieName(secure), "", { path: REFRESH_COOKIE_PATH, maxAge: 0, secure }),
  );
}

// ---- Signed OAuth state: { verifier, next, exp } ----

function signingKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", "moneypilot-oauth-state-v1", 32));
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
}

export interface OAuthState {
  verifier: string;
  next: string;
}

/** A new PKCE pair: the verifier stays on our side (signed cookie), the challenge goes to Supabase. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function setOAuthCookie(
  reply: FastifyReply,
  state: OAuthState,
  options: { secret: string; secure: boolean; nowMs: number },
): void {
  const exp = Math.floor(options.nowMs / 1000) + OAUTH_MAX_AGE_SECONDS;
  const payload = Buffer.from(JSON.stringify({ v: state.verifier, n: state.next, e: exp })).toString(
    "base64url",
  );
  appendSetCookie(
    reply,
    serialize(oauthCookieName(options.secure), `${payload}.${sign(payload, options.secret)}`, {
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_MAX_AGE_SECONDS,
      secure: options.secure,
    }),
  );
}

export function clearOAuthCookie(reply: FastifyReply, secure: boolean): void {
  appendSetCookie(
    reply,
    serialize(oauthCookieName(secure), "", { path: OAUTH_COOKIE_PATH, maxAge: 0, secure }),
  );
}

/** The verified, unexpired state, or null for anything missing, forged or stale. */
export function readOAuthState(
  request: FastifyRequest,
  options: { secret: string; secure: boolean; nowMs: number },
): OAuthState | null {
  const raw = readCookie(request, oauthCookieName(options.secure));
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload, options.secret), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: unknown;
      n?: unknown;
      e?: unknown;
    };
    if (typeof parsed.v !== "string" || typeof parsed.n !== "string" || typeof parsed.e !== "number")
      return null;
    if (parsed.e < Math.floor(options.nowMs / 1000)) return null;
    return { verifier: parsed.v, next: parsed.n };
  } catch {
    return null;
  }
}
