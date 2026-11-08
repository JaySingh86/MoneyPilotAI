// A small server-side client for Supabase Auth (GoTrue REST, ADR-020). Only the API process holds the
// publishable and secret keys; web and mobile reach these calls through `/v1/auth/*`.
//
// Hard rule 8: upstream bodies and messages can echo emails, so they never leave this file. A failure is a
// `GoTrueError` carrying only the HTTP status and Supabase's stable `error_code`.
import { z } from "zod";

export interface GoTrueConfig {
  /** `https://<ref>.supabase.co` (no trailing slash, no `/auth/v1`). */
  url: string;
  /** Sent as `apikey` on every call. Server-side only. */
  publishableKey: string;
  /** Server-side only. Held for admin calls (account deletion, WP-24); the sign-in calls here do not need it. */
  secretKey: string;
  /** Replaces global fetch (tests serve a fake GoTrue from memory; there is no network in tests). */
  fetch?: typeof fetch;
  /** Per-call timeout. Default 10 s. */
  timeoutMs?: number;
}

export class GoTrueError extends Error {
  override readonly name = "GoTrueError";
  constructor(
    readonly status: number,
    /** Supabase's `error_code` (for example `invalid_credentials`); `unknown` when absent. */
    readonly errorCode: string,
  ) {
    // Static message on purpose: nothing from the response body.
    super(`Supabase Auth call failed (${status} ${errorCode})`);
  }
  /** The provider could not be reached or answered with a server error: not the caller's fault. */
  get unavailable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface GoTrueSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface GoTrueFactor {
  id: string;
  type: string;
  status: "verified" | "unverified";
}

export interface GoTrueUser {
  id: string;
  email: string | null;
  /** `email_confirmed_at` (ISO) or null. */
  emailConfirmedAt: string | null;
  factors: GoTrueFactor[];
  firstName: string | null;
}

const SessionBody = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  expires_at: z.number().int().positive().optional(),
});

const UserBody = z.object({
  id: z.string().min(1),
  email: z.string().nullish(),
  email_confirmed_at: z.string().nullish(),
  confirmed_at: z.string().nullish(),
  factors: z.array(z.object({ id: z.string(), factor_type: z.string(), status: z.string() })).nullish(),
  user_metadata: z.record(z.string(), z.unknown()).nullish(),
});

const ErrorBody = z.object({
  error_code: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});

export type OtpVerification =
  | { type: "signup" | "recovery" | "email"; email: string; token: string }
  | { type: "signup" | "recovery" | "email"; tokenHash: string };

export interface GoTrueClient {
  signUp(input: { email: string; password: string; firstName: string; redirectTo?: string }): Promise<void>;
  signInWithPassword(input: { email: string; password: string }): Promise<GoTrueSession>;
  verifyOtp(input: OtpVerification): Promise<GoTrueSession>;
  resendSignup(email: string): Promise<void>;
  recover(email: string): Promise<void>;
  refresh(refreshToken: string): Promise<GoTrueSession>;
  /** Revokes the session the access token belongs to. */
  logout(accessToken: string): Promise<void>;
  /** Revokes every other session of the user (after a password reset). */
  logoutOthers(accessToken: string): Promise<void>;
  getUser(accessToken: string): Promise<GoTrueUser>;
  updatePassword(accessToken: string, password: string): Promise<void>;
  mfaEnrollTotp(
    accessToken: string,
    friendlyName: string,
  ): Promise<{ factorId: string; uri: string; secret: string }>;
  mfaChallenge(accessToken: string, factorId: string): Promise<{ challengeId: string }>;
  mfaVerify(input: {
    accessToken: string;
    factorId: string;
    challengeId: string;
    code: string;
  }): Promise<GoTrueSession>;
  /** The provider's authorize URL for PKCE sign-in (the browser is redirected to it). */
  oauthAuthorizeUrl(input: { provider: "google"; redirectTo: string; codeChallenge: string }): string;
  exchangePkceCode(input: { authCode: string; codeVerifier: string }): Promise<GoTrueSession>;
}

export function createGoTrueClient(config: GoTrueConfig): GoTrueClient {
  const base = `${config.url.replace(/\/+$/, "")}/auth/v1`;
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function call(
    method: "GET" | "POST" | "PUT",
    path: string,
    options: { body?: unknown; accessToken?: string } = {},
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          apikey: config.publishableKey,
          "content-type": "application/json",
          ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new GoTrueError(0, "unreachable");
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(json);
      const code = parsed.success ? (parsed.data.error_code ?? String(parsed.data.code ?? "")) : "";
      throw new GoTrueError(res.status, code === "" ? "unknown" : code);
    }
    return json;
  }

  function toSession(json: unknown): GoTrueSession {
    const parsed = SessionBody.safeParse(json);
    if (!parsed.success) throw new GoTrueError(502, "bad_response");
    const { access_token, refresh_token, expires_at, expires_in } = parsed.data;
    const expiresAt = expires_at ?? Math.floor(Date.now() / 1000) + (expires_in ?? 3600);
    return { accessToken: access_token, refreshToken: refresh_token, expiresAt };
  }

  return {
    async signUp({ email, password, firstName, redirectTo }) {
      await call("POST", redirectTo ? `/signup?redirect_to=${encodeURIComponent(redirectTo)}` : "/signup", {
        body: { email, password, data: { first_name: firstName } },
      });
    },
    async signInWithPassword({ email, password }) {
      return toSession(await call("POST", "/token?grant_type=password", { body: { email, password } }));
    },
    async verifyOtp(input) {
      const body =
        "tokenHash" in input
          ? { type: input.type, token_hash: input.tokenHash }
          : { type: input.type, email: input.email, token: input.token };
      return toSession(await call("POST", "/verify", { body }));
    },
    async resendSignup(email) {
      await call("POST", "/resend", { body: { type: "signup", email } });
    },
    async recover(email) {
      await call("POST", "/recover", { body: { email } });
    },
    async refresh(refreshToken) {
      return toSession(
        await call("POST", "/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } }),
      );
    },
    async logout(accessToken) {
      await call("POST", "/logout?scope=local", { accessToken });
    },
    async logoutOthers(accessToken) {
      await call("POST", "/logout?scope=others", { accessToken });
    },
    async getUser(accessToken) {
      const parsed = UserBody.safeParse(await call("GET", "/user", { accessToken }));
      if (!parsed.success) throw new GoTrueError(502, "bad_response");
      const u = parsed.data;
      // Email sign-up stores `first_name`; Google supplies `given_name`.
      const first = u.user_metadata?.first_name ?? u.user_metadata?.given_name;
      return {
        id: u.id,
        email: u.email ?? null,
        emailConfirmedAt: u.email_confirmed_at ?? u.confirmed_at ?? null,
        factors: (u.factors ?? []).map((f) => ({
          id: f.id,
          type: f.factor_type,
          status: f.status === "verified" ? "verified" : "unverified",
        })),
        firstName: typeof first === "string" ? first : null,
      };
    },
    async updatePassword(accessToken, password) {
      await call("PUT", "/user", { accessToken, body: { password } });
    },
    async mfaEnrollTotp(accessToken, friendlyName) {
      const json = await call("POST", "/factors", {
        accessToken,
        body: { factor_type: "totp", friendly_name: friendlyName, issuer: "MoneyPilot" },
      });
      const parsed = z
        .object({ id: z.string(), totp: z.object({ uri: z.string(), secret: z.string() }) })
        .safeParse(json);
      if (!parsed.success) throw new GoTrueError(502, "bad_response");
      return { factorId: parsed.data.id, uri: parsed.data.totp.uri, secret: parsed.data.totp.secret };
    },
    async mfaChallenge(accessToken, factorId) {
      const json = await call("POST", `/factors/${encodeURIComponent(factorId)}/challenge`, {
        accessToken,
        body: {},
      });
      const parsed = z.object({ id: z.string() }).safeParse(json);
      if (!parsed.success) throw new GoTrueError(502, "bad_response");
      return { challengeId: parsed.data.id };
    },
    async mfaVerify({ accessToken, factorId, challengeId, code }) {
      return toSession(
        await call("POST", `/factors/${encodeURIComponent(factorId)}/verify`, {
          accessToken,
          body: { challenge_id: challengeId, code },
        }),
      );
    },
    oauthAuthorizeUrl({ provider, redirectTo, codeChallenge }) {
      const q = new URLSearchParams({
        provider,
        redirect_to: redirectTo,
        code_challenge: codeChallenge,
        code_challenge_method: "s256",
      });
      return `${base}/authorize?${q.toString()}`;
    },
    async exchangePkceCode({ authCode, codeVerifier }) {
      return toSession(
        await call("POST", "/token?grant_type=pkce", {
          body: { auth_code: authCode, code_verifier: codeVerifier },
        }),
      );
    },
  };
}
