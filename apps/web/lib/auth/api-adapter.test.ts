// The API auth adapter against a scripted fetch: it calls only `/v1/auth/*` on our API, keeps the access token
// in memory, never touches Supabase, and never reads the refresh cookie (the API owns it).
import { describe, expect, it, vi } from "vitest";
import { createApiAuthAdapter } from "./api-adapter";
import { AuthError, authMessage } from "./types";

const BASE = "http://localhost:4000";
const NOW = Date.parse("2026-11-09T12:00:00Z");

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "ES256" })}.${b64(claims)}.sig`;
}
const session = (token = "tok-1", expiresInS = 3600, aal = "aal1") => ({
  status: "signed_in",
  session: {
    accessToken: token === "tok-1" ? jwt({ email: "sam@example.test" }) : token,
    expiresAt: new Date(NOW + expiresInS * 1000).toISOString(),
    aal,
  },
});
const reply = (status: number, body: unknown = null) =>
  new Response(body === null ? null : JSON.stringify(body), { status });

type Call = { url: string; init: RequestInit };
function setup(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call to ${String(input)}`);
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  const adapter = createApiAuthAdapter({ baseUrl: BASE, fetch: fetchFn, now: () => NOW });
  return { adapter, calls };
}
const path = (c: Call) => c.url.replace(`${BASE}/v1/auth/`, "");
const headerOf = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe("API auth adapter", () => {
  it("getSession trades the cookie for an access token and keeps it in memory", async () => {
    const { adapter, calls } = setup([reply(200, session())]);
    const first = await adapter.getSession();
    const second = await adapter.getSession();
    expect(first?.email).toBe("sam@example.test");
    expect(second?.accessToken).toBe(first?.accessToken);
    expect(calls).toHaveLength(1); // the second call used memory
    expect(path(calls[0]!)).toBe("refresh");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(headerOf(calls[0]!, "x-mp-client")).toBe("web");
    expect(headerOf(calls[0]!, "authorization")).toBeUndefined();
  });

  it("concurrent getSession calls share one refresh (tokens rotate)", async () => {
    const { adapter, calls } = setup([reply(200, session())]);
    const [a, b, c] = await Promise.all([adapter.getSession(), adapter.getSession(), adapter.getSession()]);
    expect(a?.accessToken).toBe(b?.accessToken);
    expect(c).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("refreshes again when the access token is about to expire", async () => {
    const { adapter, calls } = setup([reply(200, session("tok-1", 10)), reply(200, session("tok-2", 3600))]);
    await adapter.getSession();
    const next = await adapter.getSession();
    expect(next?.accessToken).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("no cookie (401) is signed out; a server error is a network error, not signed out", async () => {
    const out = setup([reply(401, { code: "unauthorized" })]);
    await expect(out.adapter.getSession()).resolves.toBeNull();
    const down = setup([reply(503, { code: "internal_error" })]);
    await expect(down.adapter.getSession()).rejects.toMatchObject({ code: "network" });
  });

  it("signIn sends the credentials to our API only and notifies listeners", async () => {
    const { adapter, calls } = setup([reply(200, session())]);
    const listener = vi.fn();
    adapter.onTokensChanged(listener);
    await expect(adapter.signIn("sam@example.test", "pw")).resolves.toEqual({ step: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/sign-in`);
    expect(calls.every((c) => c.url.startsWith(BASE))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // No further call is needed: the session is in memory.
    expect((await adapter.getSession())?.email).toBe("sam@example.test");
    expect(calls).toHaveLength(1);
  });

  it("a wrong password is invalid_credentials; rate limits and outages have their own codes", async () => {
    for (const [res, code] of [
      [reply(401, { code: "unauthorized" }), "invalid_credentials"],
      [reply(429, { code: "rate_limited" }), "rate_limited"],
      [reply(503, { code: "internal_error" }), "network"],
    ] as const) {
      const { adapter } = setup([res]);
      await expect(adapter.signIn("a@example.test", "x")).rejects.toMatchObject({ code });
    }
    const offline = createApiAuthAdapter({
      baseUrl: BASE,
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    });
    await expect(offline.signIn("a@example.test", "x")).rejects.toMatchObject({ code: "network" });
  });

  it("an unconfirmed account is sent to the confirm step without a session", async () => {
    const { adapter } = setup([reply(200, { status: "confirm_email" })]);
    await expect(adapter.signIn("a@example.test", "pw")).resolves.toEqual({ step: "confirm_sign_up" });
    // Still signed out: getSession falls back to the cookie.
    const again = setup([reply(200, { status: "confirm_email" }), reply(401)]);
    await again.adapter.signIn("a@example.test", "pw");
    await expect(again.adapter.getSession()).resolves.toBeNull();
  });

  it("an authenticator account holds the aal1 session back until the code is verified", async () => {
    const factorId = "11111111-1111-4111-8111-111111111111";
    const aal1 = session("aal1-token");
    const { adapter, calls } = setup([
      reply(200, { status: "mfa_required", factorId, session: aal1.session }),
      reply(401), // getSession while pending: no cookie session is treated as signed in by us
      reply(200, session("aal2-token", 3600, "aal2")),
    ]);
    const listener = vi.fn();
    adapter.onTokensChanged(listener);
    await expect(adapter.signIn("a@example.test", "pw")).resolves.toEqual({ step: "totp" });
    expect(listener).not.toHaveBeenCalled();
    await expect(adapter.getSession()).resolves.toBeNull();
    await expect(adapter.confirmTotp("123456")).resolves.toEqual({ step: "done" });
    const verify = calls[2]!;
    expect(path(verify)).toBe("mfa/verify");
    expect(headerOf(verify, "authorization")).toBe("Bearer aal1-token");
    expect(JSON.parse(String(verify.init.body))).toEqual({ factorId, code: "123456" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await adapter.getSession())?.accessToken).toBe("aal2-token");
  });

  it("sign-up sends the first name and goes to confirm; confirming signs in", async () => {
    const { adapter, calls } = setup([reply(202, { status: "accepted" }), reply(200, session())]);
    const listener = vi.fn();
    adapter.onTokensChanged(listener);
    await expect(
      adapter.signUp({ email: "a@example.test", password: "a long password", firstName: "Alex" }),
    ).resolves.toEqual({ step: "confirm_sign_up" });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ firstName: "Alex" });
    await adapter.confirmSignUp("a@example.test", "123456");
    expect(path(calls[1]!)).toBe("confirm-email");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await adapter.getSession())?.email).toBe("sam@example.test");
  });

  it("a weak password on sign-up is weak_password", async () => {
    const { adapter } = setup([reply(400, { code: "validation_failed" })]);
    await expect(
      adapter.signUp({ email: "a@example.test", password: "12345678", firstName: "A" }),
    ).rejects.toMatchObject({ code: "weak_password" });
  });

  it("password reset passes the authenticator code and maps mfa_required", async () => {
    const needs = setup([reply(403, { code: "mfa_required" })]);
    const failure = await needs.adapter
      .confirmPasswordReset("a@example.test", "123456", "new password 1")
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuthError);
    expect((failure as AuthError).code).toBe("mfa_required");
    expect(authMessage(failure)).toMatch(/authenticator app/);

    const ok = setup([reply(200, session("tok-r", 3600, "aal2"))]);
    await ok.adapter.confirmPasswordReset("a@example.test", "123456", "new password 1", "654321");
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({
      email: "a@example.test",
      code: "123456",
      newPassword: "new password 1",
      mfaCode: "654321",
    });
  });

  it("stepUp verifies the code with the current access token and keeps the upgraded session", async () => {
    const { adapter, calls } = setup([reply(200, session()), reply(200, session("tok-aal2", 3600, "aal2"))]);
    await adapter.stepUp("123456");
    const verify = calls[1]!;
    expect(path(verify)).toBe("mfa/verify");
    expect(JSON.parse(String(verify.init.body))).toEqual({ code: "123456" });
    expect((await adapter.getSession())?.accessToken).toBe("tok-aal2");
  });

  it("stepUp: a wrong code is invalid_code; no authenticator is no_authenticator", async () => {
    const wrong = setup([reply(200, session()), reply(400, { code: "bad_request" })]);
    await expect(wrong.adapter.stepUp("000000")).rejects.toMatchObject({ code: "invalid_code" });
    const none = setup([reply(200, session()), reply(404, { code: "not_found" })]);
    await expect(none.adapter.stepUp("123456")).rejects.toMatchObject({ code: "no_authenticator" });
  });

  it("setUpTotp returns the secret and URI once; confirm verifies the new factor", async () => {
    const factorId = "22222222-2222-4222-8222-222222222222";
    const { adapter, calls } = setup([
      reply(200, session()),
      reply(200, { factorId, otpauthUri: "otpauth://totp/MoneyPilot:x?secret=ABC", secret: "ABC" }),
      reply(200, session("tok-aal2", 3600, "aal2")),
    ]);
    const setupResult = await adapter.setUpTotp();
    expect(setupResult.sharedSecret).toBe("ABC");
    expect(setupResult.setupUri).toMatch(/^otpauth:\/\//);
    await setupResult.confirm("123456");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ factorId, code: "123456" });
    expect((await adapter.getSession())?.accessToken).toBe("tok-aal2");
  });

  it("signOut clears memory and calls the API, sending the token only while it is still valid", async () => {
    const { adapter, calls } = setup([reply(200, session()), reply(204), reply(401)]);
    await adapter.getSession();
    await adapter.signOut();
    expect(path(calls[1]!)).toBe("sign-out");
    expect(headerOf(calls[1]!, "authorization")).toMatch(/^Bearer /);
    await expect(adapter.getSession()).resolves.toBeNull();

    const stale = setup([reply(200, session("tok-1", 5)), reply(204)]);
    await stale.adapter.getSession();
    await stale.adapter.signOut();
    expect(headerOf(stale.calls[1]!, "authorization")).toBeUndefined();
  });

  it("Google sign-in navigates to our API's start route with the return path", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { adapter } = setup([]);
    await adapter.signInWithGoogle("/invite");
    expect(assign).toHaveBeenCalledWith(`${BASE}/v1/auth/google/start?next=%2Finvite`);
    vi.unstubAllGlobals();
  });

  it("never holds a token in web storage", async () => {
    const { adapter } = setup([reply(200, session())]);
    await adapter.signIn("a@example.test", "pw");
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        expect(store.getItem(store.key(i) ?? "")).not.toMatch(/tok|eyJ|\./);
      }
    }
  });
});
