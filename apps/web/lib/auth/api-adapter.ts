// Sign-in through our own API (ADR-020). The browser never talks to Supabase: every call goes to
// `/v1/auth/*`, and only the API holds the Supabase keys.
//
// Tokens: the access token lives in memory only (never localStorage). The refresh token is an httpOnly cookie
// the API sets, so no script here can read it. A page load, or an expiring access token, trades the cookie for
// a new access token with `POST /v1/auth/refresh` (single flight, because refresh tokens rotate).
import type { AuthAdapter, AuthSession, SignInStep, SignUpInput, TotpSetup } from "./types";
import { AuthError } from "./types";

/** Sent on every call: tells the API this is the browser client (cookie, not body, for the refresh token). */
const CLIENT_HEADER = "x-mp-client";
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 30_000;

interface ApiSession {
  accessToken: string;
  expiresAt: string;
  aal: "aal1" | "aal2";
}

type Held = { accessToken: string; expiresAtMs: number; email: string | null };

export interface ApiAdapterOptions {
  baseUrl: string;
  /** Tests inject a fake; default is the global fetch. */
  fetch?: typeof fetch;
  /** Clock in epoch ms (tests). */
  now?: () => number;
}

interface CallResult {
  status: number;
  body: Record<string, unknown> | null;
}

/** The email inside the access token, for display only. Nothing is decided from it: the API verifies the token. */
function emailFromToken(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const email = (JSON.parse(json) as { email?: unknown }).email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

/** Maps an API problem to our error codes. Copy lives in `authMessage`; nothing here says whether an account exists. */
function toAuthError(result: CallResult, context: "password" | "other"): AuthError {
  const code = typeof result.body?.code === "string" ? result.body.code : "";
  if (result.status === 429) return new AuthError("rate_limited", "rate_limited");
  if (result.status === 0 || result.status >= 500) return new AuthError("network", `status ${result.status}`);
  if (code === "mfa_required") return new AuthError("mfa_required", code);
  if (code === "not_found") return new AuthError("no_authenticator", code);
  if (code === "unauthorized") return new AuthError("invalid_credentials", code);
  if (code === "bad_request") return new AuthError("invalid_code", code);
  if (code === "validation_failed" && context === "password") return new AuthError("weak_password", code);
  return new AuthError("unknown", code || `status ${result.status}`);
}

export function createApiAuthAdapter(options: ApiAdapterOptions): AuthAdapter {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((l) => l());

  let held: Held | null = null;
  let refreshing: Promise<Held | null> | null = null;
  /** An aal1 session waiting for its authenticator code (never exposed as "signed in"). */
  let pendingMfa: { accessToken: string; factorId: string } | null = null;

  async function call(
    path: string,
    init: { body?: unknown; bearer?: string | null } = {},
  ): Promise<CallResult> {
    let response: Response;
    try {
      response = await doFetch(`${base}/v1/auth/${path}`, {
        method: "POST",
        // The cookie rides along; `x-mp-client: web` plus the browser's Origin is the API's CSRF check.
        credentials: "include",
        redirect: "error",
        headers: {
          accept: "application/json",
          [CLIENT_HEADER]: "web",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      return { status: 0, body: null };
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  function hold(session: ApiSession): Held {
    held = {
      accessToken: session.accessToken,
      expiresAtMs: Date.parse(session.expiresAt),
      email: emailFromToken(session.accessToken),
    };
    return held;
  }

  /** Reads `{ status: "signed_in", session }` and keeps the session; anything else is an error. */
  function takeSession(result: CallResult, context: "password" | "other" = "other"): ApiSession {
    const session = result.body?.session as ApiSession | undefined;
    if (result.status !== 200 || !session?.accessToken) throw toAuthError(result, context);
    hold(session);
    return session;
  }

  function fresh(): Held | null {
    return held && held.expiresAtMs - EXPIRY_MARGIN_MS > now() ? held : null;
  }

  async function refresh(): Promise<Held | null> {
    const result = await call("refresh");
    if (result.status === 200) {
      const session = result.body?.session as ApiSession | undefined;
      return session?.accessToken ? hold(session) : null;
    }
    if (result.status === 401 || result.status === 403) {
      held = null;
      return null; // signed out (no cookie, or it is dead)
    }
    throw toAuthError(result, "other");
  }

  const adapter: AuthAdapter = {
    kind: "api",

    async getSession(): Promise<AuthSession | null> {
      let current = fresh();
      if (!current) {
        refreshing ??= refresh().finally(() => {
          refreshing = null;
        });
        current = await refreshing;
      }
      return current ? { accessToken: current.accessToken, email: current.email, firstName: null } : null;
    },

    async signIn(email, password): Promise<SignInStep> {
      pendingMfa = null;
      const result = await call("sign-in", { body: { email, password } });
      const status = result.body?.status;
      if (result.status === 200 && status === "confirm_email") return { step: "confirm_sign_up" };
      if (result.status === 200 && status === "mfa_required") {
        const session = result.body?.session as ApiSession | undefined;
        const factorId = result.body?.factorId;
        if (!session?.accessToken || typeof factorId !== "string") throw toAuthError(result, "other");
        pendingMfa = { accessToken: session.accessToken, factorId };
        return { step: "totp" };
      }
      takeSession(result);
      emit();
      return { step: "done" };
    },

    async confirmTotp(code): Promise<SignInStep> {
      if (!pendingMfa) throw new AuthError("unknown", "no sign-in in progress");
      const { accessToken, factorId } = pendingMfa;
      takeSession(await call("mfa/verify", { body: { factorId, code }, bearer: accessToken }));
      pendingMfa = null;
      emit();
      return { step: "done" };
    },

    async signUp({ email, password, firstName }: SignUpInput): Promise<SignInStep> {
      const result = await call("sign-up", { body: { email, password, firstName } });
      if (result.status !== 202) throw toAuthError(result, "password");
      return { step: "confirm_sign_up" };
    },

    async confirmSignUp(email, code): Promise<void> {
      // Confirming signs the new account in (the API returns its session).
      takeSession(await call("confirm-email", { body: { email, code } }));
      emit();
    },

    async resendSignUpCode(email): Promise<void> {
      const result = await call("resend-confirmation", { body: { email } });
      if (result.status !== 202) throw toAuthError(result, "other");
    },

    async requestPasswordReset(email): Promise<void> {
      const result = await call("password-reset/request", { body: { email } });
      if (result.status !== 202) throw toAuthError(result, "other");
    },

    async confirmPasswordReset(email, code, newPassword, mfaCode): Promise<void> {
      takeSession(
        await call("password-reset/confirm", {
          body: { email, code, newPassword, ...(mfaCode ? { mfaCode } : {}) },
        }),
        "password",
      );
      emit();
    },

    async signInWithGoogle(next): Promise<void> {
      // A full-page navigation to our API, which redirects to Google and back. The API sets the session
      // cookie on the way back and lands on `next`, where `getSession` trades the cookie for a token.
      const url = new URL(`${base}/v1/auth/google/start`);
      if (next) url.searchParams.set("next", next);
      window.location.assign(url.toString());
    },

    async stepUp(code): Promise<void> {
      const current = await adapter.getSession();
      if (!current) throw new AuthError("invalid_credentials", "signed out");
      takeSession(await call("mfa/verify", { body: { code }, bearer: current.accessToken }));
      emit();
    },

    async setUpTotp(): Promise<TotpSetup> {
      const current = await adapter.getSession();
      if (!current) throw new AuthError("invalid_credentials", "signed out");
      const result = await call("mfa/totp/enrol", { bearer: current.accessToken });
      const { factorId, otpauthUri, secret } = (result.body ?? {}) as Record<string, unknown>;
      if (
        result.status !== 200 ||
        typeof factorId !== "string" ||
        typeof otpauthUri !== "string" ||
        typeof secret !== "string"
      ) {
        throw toAuthError(result, "other");
      }
      return {
        sharedSecret: secret,
        setupUri: otpauthUri,
        async confirm(code: string) {
          const token = (await adapter.getSession())?.accessToken;
          if (!token) throw new AuthError("invalid_credentials", "signed out");
          takeSession(await call("mfa/verify", { body: { factorId, code }, bearer: token }));
          emit();
        },
      };
    },

    async signOut(): Promise<void> {
      // Only a still-valid token is sent: an expired one would be refused before the route clears the cookie.
      const token = fresh()?.accessToken ?? null;
      held = null;
      pendingMfa = null;
      // Best effort: the cookie is cleared by the API, and the local state is already gone.
      await call("sign-out", { bearer: token });
    },

    onTokensChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return adapter;
}
