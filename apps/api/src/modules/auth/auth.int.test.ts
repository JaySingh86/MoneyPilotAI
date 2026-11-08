// /v1/auth/* over HTTP: the real routes and GoTrue client against an in-memory fake Supabase Auth (no network),
// and the real database for bootstrap. Covers sign-up to bootstrap, sessions and cookies, CSRF, MFA, step-up,
// password reset, Google PKCE, rate limits and no-enumeration.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { createApiDb, type ApiDb } from "@mp/db";
import { createAuthenticator } from "../../auth/authenticator";
import { createSupabaseProvider } from "../../auth/supabase";
import type { AuthProvider } from "../../auth/provider";
import { FAKE_TOTP_CODE, FakeSupabase } from "../../auth/testing/fake-supabase";
import { expectProblem } from "../../lib/testing";
import { buildServer, type ApiServer } from "../../server";
import type { RateLimitOptions } from "../../plugins/rate-limit";
import { createIdentityModule } from "../identity";
import type { ApiRuntime } from "../../auth/runtime";
import { createAuthModule } from ".";
const OAUTH_COOKIE = "mp_oauth";
import type { AuthModuleConfig } from "./runtime";

const WEB = "http://localhost:3100";
const config: AuthModuleConfig = {
  webOrigin: WEB,
  apiPublicUrl: "http://localhost:4000",
  cookieSecure: false,
  cookieSecret: "test-cookie-secret",
};
const PASSWORD = "correct horse battery";

let fake: FakeSupabase;
let db: ApiDb;
let provider: AuthProvider;
let app: ApiServer;

function build(rateLimit?: RateLimitOptions, cfg = config) {
  const rt: ApiRuntime = { db, provider, inviteSender: { send: async () => undefined } };
  return buildServer({
    authenticate: createAuthenticator({ provider, db }),
    modules: [
      createIdentityModule(() => rt),
      createAuthModule(() => ({ gotrue: fake.gotrue(), config: cfg })),
    ],
    rateLimit: rateLimit ?? {
      groups: {
        authCredentials: { max: 10_000, timeWindow: "1 minute" },
        authSession: { max: 10_000, timeWindow: "1 minute" },
      },
    },
  });
}

beforeAll(async () => {
  fake = await FakeSupabase.create();
  db = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 4 });
  provider = createSupabaseProvider(fake.providerConfig());
  app = build();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object | undefined, headers });
const webHeaders = (cookie?: string): Record<string, string> => ({
  "x-mp-client": "web",
  origin: WEB,
  ...(cookie ? { cookie } : {}),
});
const setCookies = (res: LightMyRequestResponse): string[] => {
  const raw = res.headers["set-cookie"];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
};
const cookieOf = (res: LightMyRequestResponse, name: string): string | undefined =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));
const cookiePair = (c: string): string => c.split(";")[0] ?? "";
type SessionBody = { status: string; session: { accessToken: string; refreshToken?: string; aal: string } };
const bearer = (res: LightMyRequestResponse) => ({
  authorization: `Bearer ${(res.json() as SessionBody).session.accessToken}`,
});

async function confirmedUser(label = "u", options: { firstName?: string } = {}) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const firstName = options.firstName ?? "Riley";
  expect((await post("/v1/auth/sign-up", { firstName, email, password: PASSWORD })).statusCode).toBe(202);
  const mail = fake.lastMail(email, "signup");
  if (!mail) throw new Error("no confirmation mail");
  const res = await post("/v1/auth/confirm-email", { email, code: mail.code });
  expect(res.statusCode).toBe(200);
  return { email, firstName, res };
}

describe("sign up, confirm, bootstrap", () => {
  it("sign-up is 202 and mails a code; confirming signs in; bootstrap needs no body and uses the sign-up name", async () => {
    const { email, res } = await confirmedUser("flow", { firstName: "Casey" });
    expect(res.json()).toMatchObject({ status: "signed_in", session: { aal: "aal1" } });
    // Web: the refresh token is a cookie, never in the body.
    expect((res.json() as SessionBody).session.refreshToken).toBeUndefined();
    const cookie = cookieOf(res, "mp_rt");
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/v1\/auth(;|$)/);
    expect(cookie).not.toMatch(/Secure/); // localhost config
    expect(res.headers["cache-control"]).toBe("no-store");

    const boot = await app.inject({ method: "POST", url: "/v1/me/bootstrap", headers: bearer(res) });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toMatchObject({ email, firstName: "Casey", mfaEnabled: false });
  });

  it("the cookie is Secure outside plain-http localhost", async () => {
    const secure = build(undefined, { ...config, cookieSecure: true });
    await secure.ready();
    const email = `sec-${randomUUID().slice(0, 8)}@example.test`;
    await secure.inject({
      method: "POST",
      url: "/v1/auth/sign-up",
      payload: { firstName: "S", email, password: PASSWORD },
    });
    const mail = fake.lastMail(email, "signup");
    const res = await secure.inject({
      method: "POST",
      url: "/v1/auth/confirm-email",
      payload: { email, code: mail?.code },
    });
    expect(cookieOf(res, "__Secure-mp_rt")).toMatch(/; Secure/);
    await secure.close();
  });

  it("confirms with a link token hash too; the code or hash works once", async () => {
    const email = `hash-${randomUUID().slice(0, 8)}@example.test`;
    await post("/v1/auth/sign-up", { firstName: "H", email, password: PASSWORD });
    const mail = fake.lastMail(email, "signup");
    const ok = await post("/v1/auth/confirm-email", { tokenHash: mail?.tokenHash });
    expect(ok.statusCode).toBe(200);
    expectProblem(await post("/v1/auth/confirm-email", { tokenHash: mail?.tokenHash }), 400, "bad_request");
  });

  it("a wrong code and an unknown address fail the same way", async () => {
    const wrong = await post("/v1/auth/confirm-email", { email: "nobody@example.test", code: "000000" });
    expectProblem(wrong, 400, "bad_request");
    const { email } = await confirmedUser("wrongcode");
    const again = await post("/v1/auth/confirm-email", { email, code: "000000" });
    expect(again.json()).toMatchObject({ detail: (wrong.json() as { detail: string }).detail });
  });

  it("requires exactly one of code (with email) or tokenHash", async () => {
    expectProblem(
      await post("/v1/auth/confirm-email", { email: "a@example.test" }),
      400,
      "validation_failed",
    );
    expectProblem(
      await post("/v1/auth/confirm-email", {
        email: "a@example.test",
        code: "123456",
        tokenHash: "abcdefgh",
      }),
      400,
      "validation_failed",
    );
  });

  it("sign-up never reveals an existing account: same 202 and body; a weak password is the caller's own error", async () => {
    const { email } = await confirmedUser("dup");
    const fresh = await post("/v1/auth/sign-up", {
      firstName: "N",
      email: `new-${randomUUID().slice(0, 8)}@example.test`,
      password: PASSWORD,
    });
    const existing = await post("/v1/auth/sign-up", { firstName: "N", email, password: PASSWORD });
    expect(existing.statusCode).toBe(202);
    expect(existing.body).toBe(fresh.body);
    const weak = await post("/v1/auth/sign-up", {
      firstName: "N",
      email: `w-${randomUUID().slice(0, 8)}@example.test`,
      password: "12345678",
    });
    // The fake rejects only under 6 chars; the contract itself enforces 8..72.
    expect(weak.statusCode).toBe(202);
    expectProblem(
      await post("/v1/auth/sign-up", { firstName: "N", email: "x@example.test", password: "short" }),
      400,
      "validation_failed",
    );
    expectProblem(
      await post("/v1/auth/sign-up", { firstName: "N", email: "x@example.test", password: "a".repeat(73) }),
      400,
      "validation_failed",
    );
    expectProblem(
      await post("/v1/auth/sign-up", { firstName: "N", email: "not-an-email", password: PASSWORD }),
      400,
      "validation_failed",
    );
  });

  it("resend and reset requests are 202 for anyone", async () => {
    for (const url of ["/v1/auth/resend-confirmation", "/v1/auth/password-reset/request"]) {
      const unknown = await post(url, { email: "ghost@example.test" });
      const { email } = await confirmedUser("known");
      const known = await post(url, { email });
      expect(unknown.statusCode).toBe(202);
      expect(known.statusCode).toBe(202);
      expect(known.body).toBe(unknown.body);
    }
  });

  it("a foreign Origin on a session-minting call is refused", async () => {
    expectProblem(
      await post(
        "/v1/auth/sign-in",
        { email: "a@example.test", password: PASSWORD },
        { origin: "https://evil.example" },
      ),
      403,
      "forbidden",
    );
  });
});

describe("sign in", () => {
  it("good credentials sign in; wrong password and unknown email are one generic 401", async () => {
    const { email } = await confirmedUser("si");
    const ok = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(ok.json()).toMatchObject({ status: "signed_in", session: { aal: "aal1" } });
    const wrong = await post("/v1/auth/sign-in", { email, password: "nope-nope-nope" });
    const unknown = await post("/v1/auth/sign-in", { email: "ghost@example.test", password: PASSWORD });
    expectProblem(wrong, 401, "unauthorized");
    expectProblem(unknown, 401, "unauthorized");
    expect(wrong.json()).toMatchObject({ detail: (unknown.json() as { detail: string }).detail });
    for (const res of [wrong, unknown]) {
      expect(res.body).not.toContain(PASSWORD);
      expect(res.body).not.toContain(email);
    }
  });

  it("an unconfirmed address with the right password gets confirm_email and no session or cookie", async () => {
    const email = `unc-${randomUUID().slice(0, 8)}@example.test`;
    await post("/v1/auth/sign-up", { firstName: "U", email, password: PASSWORD });
    const res = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(res.json()).toEqual({ status: "confirm_email" });
    expect(setCookies(res)).toEqual([]);
    // And the wrong password does not say it.
    expectProblem(await post("/v1/auth/sign-in", { email, password: "wrong-wrong" }), 401, "unauthorized");
  });

  it("an account with an authenticator gets mfa_required with its factor id and an aal1 session", async () => {
    const { email, res } = await confirmedUser("mfa");
    const enrol = await post("/v1/auth/mfa/totp/enrol", undefined, bearer(res));
    expect(enrol.statusCode).toBe(200);
    const { factorId } = enrol.json() as { factorId: string };
    expect(
      (await post("/v1/auth/mfa/verify", { factorId, code: FAKE_TOTP_CODE }, bearer(res))).statusCode,
    ).toBe(200);
    const signIn = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(signIn.json()).toMatchObject({ status: "mfa_required", factorId, session: { aal: "aal1" } });
    // Completing it yields aal2.
    const verify = await post("/v1/auth/mfa/verify", { code: FAKE_TOTP_CODE }, bearer(signIn));
    expect(verify.json()).toMatchObject({ status: "signed_in", session: { aal: "aal2" } });
  });
});

describe("refresh and sign out", () => {
  it("web: refresh reads the cookie, needs the client header and the web Origin, and rotates the cookie", async () => {
    const { res } = await confirmedUser("rf");
    const cookie = cookiePair(cookieOf(res, "mp_rt") ?? "");
    // CSRF: no header, wrong origin, no origin.
    expectProblem(await post("/v1/auth/refresh", undefined, { cookie, origin: WEB }), 403, "forbidden");
    expectProblem(
      await post("/v1/auth/refresh", undefined, { ...webHeaders(cookie), origin: "https://evil.example" }),
      403,
      "forbidden",
    );
    expectProblem(
      await post("/v1/auth/refresh", undefined, { "x-mp-client": "web", cookie }),
      403,
      "forbidden",
    );
    // No cookie.
    expectProblem(await post("/v1/auth/refresh", undefined, webHeaders()), 401, "unauthorized");

    const ok = await post("/v1/auth/refresh", undefined, webHeaders(cookie));
    expect(ok.statusCode).toBe(200);
    const next = cookiePair(cookieOf(ok, "mp_rt") ?? "");
    expect(next).not.toBe(cookie);
    expect((ok.json() as SessionBody).session.refreshToken).toBeUndefined();
    // The old token is dead (rotation); the failure clears the cookie.
    const replay = await post("/v1/auth/refresh", undefined, webHeaders(cookie));
    expectProblem(replay, 401, "unauthorized");
    expect(cookieOf(replay, "mp_rt")).toMatch(/Max-Age=0/);
  });

  it("mobile: the refresh token travels in the body, never in a cookie", async () => {
    const { email } = await confirmedUser("mob");
    const mobile = { "x-mp-client": "mobile" };
    const signIn = await post("/v1/auth/sign-in", { email, password: PASSWORD }, mobile);
    const first = (signIn.json() as SessionBody).session.refreshToken;
    expect(first).toBeTruthy();
    expect(setCookies(signIn)).toEqual([]);
    const refreshed = await post("/v1/auth/refresh", { refreshToken: first }, mobile);
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as SessionBody).session.refreshToken).toBeTruthy();
    expect(setCookies(refreshed)).toEqual([]);
    expectProblem(await post("/v1/auth/refresh", { refreshToken: "bogus" }, mobile), 401, "unauthorized");
    expectProblem(await post("/v1/auth/refresh", undefined, mobile), 401, "unauthorized");
    expectProblem(
      await post("/v1/auth/sign-in", { email, password: PASSWORD }, { "x-mp-client": "desktop" }),
      400,
      "validation_failed",
    );
  });

  it("sign-out with only the cookie revokes the session and clears the cookie; it needs CSRF headers", async () => {
    const { res } = await confirmedUser("so");
    const cookie = cookiePair(cookieOf(res, "mp_rt") ?? "");
    expectProblem(await post("/v1/auth/sign-out", undefined, { cookie }), 403, "forbidden");
    const out = await post("/v1/auth/sign-out", undefined, webHeaders(cookie));
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out, "mp_rt")).toMatch(/Max-Age=0/);
    expectProblem(await post("/v1/auth/refresh", undefined, webHeaders(cookie)), 401, "unauthorized");
  });

  it("sign-out with a bearer token revokes that session (mobile)", async () => {
    const { email } = await confirmedUser("so2");
    const mobile = { "x-mp-client": "mobile" };
    const signIn = await post("/v1/auth/sign-in", { email, password: PASSWORD }, mobile);
    const rt = (signIn.json() as SessionBody).session.refreshToken;
    expect((await post("/v1/auth/sign-out", undefined, { ...mobile, ...bearer(signIn) })).statusCode).toBe(
      204,
    );
    expectProblem(await post("/v1/auth/refresh", { refreshToken: rt }, mobile), 401, "unauthorized");
  });
});

describe("password reset", () => {
  it("sets a new password with the emailed code and signs in; the old password stops working", async () => {
    const { email } = await confirmedUser("pr");
    await post("/v1/auth/password-reset/request", { email });
    const mail = fake.lastMail(email, "recovery");
    const res = await post("/v1/auth/password-reset/confirm", {
      email,
      code: mail?.code,
      newPassword: "a brand new passphrase",
    });
    expect(res.json()).toMatchObject({ status: "signed_in" });
    expect(cookieOf(res, "mp_rt")).toBeTruthy();
    expect(
      (await post("/v1/auth/sign-in", { email, password: "a brand new passphrase" })).json(),
    ).toMatchObject({ status: "signed_in" });
    expectProblem(await post("/v1/auth/sign-in", { email, password: PASSWORD }), 401, "unauthorized");
    // The code is single use.
    expectProblem(
      await post("/v1/auth/password-reset/confirm", {
        email,
        code: mail?.code,
        newPassword: "another passphrase",
      }),
      400,
      "bad_request",
    );
  });

  it("an account with an authenticator needs the code too: 403 mfa_required without it, success with it", async () => {
    const { email, res } = await confirmedUser("prmfa");
    const { factorId } = (await post("/v1/auth/mfa/totp/enrol", undefined, bearer(res))).json() as {
      factorId: string;
    };
    await post("/v1/auth/mfa/verify", { factorId, code: FAKE_TOTP_CODE }, bearer(res));

    await post("/v1/auth/password-reset/request", { email });
    const first = fake.lastMail(email, "recovery");
    expectProblem(
      await post("/v1/auth/password-reset/confirm", {
        email,
        code: first?.code,
        newPassword: "a brand new passphrase",
      }),
      403,
      "mfa_required",
    );

    await post("/v1/auth/password-reset/request", { email });
    const second = fake.lastMail(email, "recovery");
    const ok = await post("/v1/auth/password-reset/confirm", {
      email,
      code: second?.code,
      newPassword: "a brand new passphrase",
      mfaCode: FAKE_TOTP_CODE,
    });
    expect(ok.json()).toMatchObject({ status: "signed_in", session: { aal: "aal2" } });
  });
});

describe("authenticator app (TOTP) and step-up", () => {
  it("enrol shows the secret once; a wrong code fails; the right code upgrades to a fresh aal2 that satisfies step-up", async () => {
    const { res } = await confirmedUser("totp");
    const aal1 = (res.json() as SessionBody).session.accessToken;
    await expect(provider.verifyToken(aal1).then((t) => provider.requireStepUp(t))).rejects.toMatchObject({
      code: "mfa_required",
    });

    const enrol = await post("/v1/auth/mfa/totp/enrol", undefined, bearer(res));
    const body = enrol.json() as { factorId: string; otpauthUri: string; secret: string };
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.secret.length).toBeGreaterThan(8);
    expect(enrol.headers["cache-control"]).toBe("no-store");

    expectProblem(
      await post("/v1/auth/mfa/verify", { factorId: body.factorId, code: "000000" }, bearer(res)),
      400,
      "bad_request",
    );
    const verified = await post(
      "/v1/auth/mfa/verify",
      { factorId: body.factorId, code: FAKE_TOTP_CODE },
      bearer(res),
    );
    expect(verified.json()).toMatchObject({ status: "signed_in", session: { aal: "aal2" } });
    // A new cookie is issued for the upgraded session.
    expect(cookieOf(verified, "mp_rt")).toBeTruthy();

    const upgraded = (verified.json() as SessionBody).session.accessToken;
    await expect(
      provider.verifyToken(upgraded).then((t) => provider.requireStepUp(t)),
    ).resolves.toBeUndefined();

    // Bootstrap now reports the enrolled factor.
    const boot = await app.inject({
      method: "POST",
      url: "/v1/me/bootstrap",
      headers: { authorization: `Bearer ${upgraded}` },
      payload: { firstName: "T" },
    });
    expect(boot.json()).toMatchObject({ mfaEnabled: true });
  });

  it("step-up without a factor id: verify finds the account's authenticator; an explicit challenge works too", async () => {
    const { email, res } = await confirmedUser("su");
    const { factorId } = (await post("/v1/auth/mfa/totp/enrol", undefined, bearer(res))).json() as {
      factorId: string;
    };
    await post("/v1/auth/mfa/verify", { factorId, code: FAKE_TOTP_CODE }, bearer(res));
    const signIn = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    const challenge = await post("/v1/auth/mfa/challenge", undefined, bearer(signIn));
    expect(challenge.json()).toMatchObject({ factorId });
    const { challengeId } = challenge.json() as { challengeId: string };
    const ok = await post("/v1/auth/mfa/verify", { challengeId, code: FAKE_TOTP_CODE }, bearer(signIn));
    expect((ok.json() as SessionBody).session.aal).toBe("aal2");
  });

  it("verify without an authenticator is 404; the MFA routes need a bearer token", async () => {
    const { res } = await confirmedUser("nofactor");
    expectProblem(await post("/v1/auth/mfa/verify", { code: FAKE_TOTP_CODE }, bearer(res)), 404, "not_found");
    expectProblem(await post("/v1/auth/mfa/totp/enrol"), 401, "unauthorized");
    expectProblem(await post("/v1/auth/mfa/verify", { code: FAKE_TOTP_CODE }), 401, "unauthorized");
    expectProblem(
      await post("/v1/auth/mfa/verify", { code: "12ab56" }, bearer(res)),
      400,
      "validation_failed",
    );
  });
});

describe("Google sign-in (PKCE)", () => {
  const start = (next?: string) =>
    app.inject({
      method: "GET",
      url: `/v1/auth/google/start${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`,
    });

  it("start redirects to Supabase's authorize URL with a PKCE challenge and keeps the verifier in a signed httpOnly cookie", async () => {
    const res = await start("/invite");
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe("https://fake-ref.supabase.co/auth/v1/authorize");
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("redirect_to")).toBe("http://localhost:4000/v1/auth/google/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("s256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = cookieOf(res, OAUTH_COOKIE) ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/v1\/auth\/google/);
    expect(cookie).toMatch(/Max-Age=600/);
    // The verifier is not in the URL.
    expect(String(res.headers.location)).not.toContain("code_verifier");
  });

  async function roundTrip(next: string | undefined, google: { email: string }) {
    const started = await start(next);
    const cookie = cookiePair(cookieOf(started, OAUTH_COOKIE) ?? "");
    const back = fake.completeOAuth(String(started.headers.location), google);
    const url = new URL(back);
    const callback = await app.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
      headers: { cookie },
    });
    return { started, callback, cookie, code: url.searchParams.get("code") ?? "" };
  }

  it("callback exchanges the code, sets the refresh cookie and redirects to the allowlisted web path with no token in the URL", async () => {
    const email = `g-${randomUUID().slice(0, 8)}@example.test`;
    const { callback } = await roundTrip("/invite", { email });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${WEB}/invite`);
    expect(String(callback.headers.location)).not.toMatch(/token|code/);
    const rt = cookiePair(cookieOf(callback, "mp_rt") ?? "");
    expect(rt).toMatch(/^mp_rt=rt_/);
    expect(cookieOf(callback, OAUTH_COOKIE)).toMatch(/Max-Age=0/);
    // The web app then gets its access token from /auth/refresh.
    const refreshed = await post("/v1/auth/refresh", undefined, webHeaders(rt));
    expect(refreshed.statusCode).toBe(200);
    const boot = await app.inject({
      method: "POST",
      url: "/v1/me/bootstrap",
      headers: bearer(refreshed),
      payload: { firstName: "Gia" },
    });
    expect(boot.json()).toMatchObject({ email });
  });

  it("an unlisted or hostile next falls back to /", async () => {
    for (const next of [
      "//evil.example",
      "https://evil.example",
      "/\\evil.example",
      "/admin",
      "/../etc",
      "javascript:alert(1)",
      "/overview?x=1",
    ]) {
      const { callback } = await roundTrip(next, { email: `n-${randomUUID().slice(0, 8)}@example.test` });
      expect(callback.headers.location, next).toBe(`${WEB}/`);
    }
    const { callback } = await roundTrip("/overview", {
      email: `n-${randomUUID().slice(0, 8)}@example.test`,
    });
    expect(callback.headers.location).toBe(`${WEB}/overview`);
  });

  it("a callback without our state cookie, with a forged cookie, or a replayed code goes to the sign-in error page", async () => {
    const started = await start();
    const back = new URL(
      fake.completeOAuth(String(started.headers.location), {
        email: `f-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    const path = `${back.pathname}${back.search}`;
    const noCookie = await app.inject({ method: "GET", url: path });
    expect(noCookie.headers.location).toBe(`${WEB}/sign-in?error=oauth`);
    expect(cookieOf(noCookie, "mp_rt")).toBeUndefined();

    const real = cookiePair(cookieOf(started, OAUTH_COOKIE) ?? "");
    const forged = `${real.slice(0, -3)}AAA`;
    expect(
      (await app.inject({ method: "GET", url: path, headers: { cookie: forged } })).headers.location,
    ).toBe(`${WEB}/sign-in?error=oauth`);

    // Another browser's cookie (a different verifier) cannot redeem this code: login CSRF.
    const other = cookiePair(cookieOf(await start(), OAUTH_COOKIE) ?? "");
    const swapped = await app.inject({ method: "GET", url: path, headers: { cookie: other } });
    expect(swapped.headers.location).toBe(`${WEB}/sign-in?error=oauth`);
    expect(cookieOf(swapped, "mp_rt")).toBeUndefined();

    // Provider error.
    const denied = await app.inject({
      method: "GET",
      url: "/v1/auth/google/callback?error=access_denied",
      headers: { cookie: real },
    });
    expect(denied.headers.location).toBe(`${WEB}/sign-in?error=oauth`);
  });

  it("an expired state cookie is refused", async () => {
    let t = Date.now();
    const clocked = buildServerWithClock(() => t);
    await clocked.ready();
    const started = await clocked.inject({ method: "GET", url: "/v1/auth/google/start" });
    const cookie = cookiePair(cookieOf(started, OAUTH_COOKIE) ?? "");
    const back = new URL(
      fake.completeOAuth(String(started.headers.location), {
        email: `e-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    t += 11 * 60 * 1000;
    const res = await clocked.inject({
      method: "GET",
      url: `${back.pathname}${back.search}`,
      headers: { cookie },
    });
    expect(res.headers.location).toBe(`${WEB}/sign-in?error=oauth`);
    await clocked.close();
  });
});

describe("provider failures", () => {
  it("an unreachable Supabase is a generic 503 that echoes nothing", async () => {
    fake.failNext = true;
    const res = await post("/v1/auth/sign-in", { email: "a@example.test", password: PASSWORD });
    expectProblem(res, 503, "internal_error");
    expect(res.body).not.toContain("a@example.test");
    expect(res.body).not.toContain(PASSWORD);
  });
});

describe("rate limits", () => {
  it("credential routes are limited per client: the 11th attempt in a minute is 429 with Retry-After", async () => {
    const strict = build({}); // the real default budgets
    await strict.ready();
    const hit = () =>
      strict.inject({
        method: "POST",
        url: "/v1/auth/sign-in",
        payload: { email: `a${randomUUID().slice(0, 8)}@example.test`, password: PASSWORD },
      });
    for (let i = 0; i < 10; i++) expect((await hit()).statusCode).toBe(401);
    const limited = await hit();
    expectProblem(limited, 429, "rate_limited");
    expect(limited.headers["retry-after"]).toBeDefined();
    // The budget is shared by every credential route.
    expect(
      (
        await strict.inject({
          method: "POST",
          url: "/v1/auth/sign-up",
          payload: { firstName: "A", email: "b@example.test", password: PASSWORD },
        })
      ).statusCode,
    ).toBe(429);
    await strict.close();
  });
});

describe("a second authenticator cannot be minted from a weaker session (G1 review B1)", () => {
  async function enrolledUser(label: string) {
    const { email, res } = await confirmedUser(label);
    const { factorId } = (await post("/v1/auth/mfa/totp/enrol", undefined, bearer(res))).json() as {
      factorId: string;
    };
    await post("/v1/auth/mfa/verify", { factorId, code: FAKE_TOTP_CODE }, bearer(res));
    return { email, factorId };
  }

  it.each([true, false])(
    "an aal1 session cannot enrol once a factor is verified (provider aal rules enforced: %s)",
    async (enforceAal) => {
      const { email } = await enrolledUser("b1enrol");
      fake.enforceAal = enforceAal;
      try {
        const aal1 = await post("/v1/auth/sign-in", { email, password: PASSWORD });
        expect(aal1.json()).toMatchObject({ status: "mfa_required", session: { aal: "aal1" } });
        expectProblem(await post("/v1/auth/mfa/totp/enrol", undefined, bearer(aal1)), 403, "mfa_required");
      } finally {
        fake.enforceAal = true;
      }
    },
  );

  it("an aal2 session may add another authenticator, but it can never be verified while the first one stands", async () => {
    const { email, factorId } = await enrolledUser("b1second");
    const aal1 = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    const aal2 = await post("/v1/auth/mfa/verify", { code: FAKE_TOTP_CODE }, bearer(aal1));
    const added = await post("/v1/auth/mfa/totp/enrol", undefined, bearer(aal2));
    expect(added.statusCode).toBe(200);
    const newId = (added.json() as { factorId: string }).factorId;
    expect(newId).not.toBe(factorId);

    // Back at aal1 (a password sign-in), the new unverified factor cannot be used to reach aal2.
    fake.enforceAal = false;
    try {
      const weak = await post("/v1/auth/sign-in", { email, password: PASSWORD });
      for (const id of [newId, "99999999-9999-4999-8999-999999999999"]) {
        expectProblem(
          await post("/v1/auth/mfa/verify", { factorId: id, code: FAKE_TOTP_CODE }, bearer(weak)),
          403,
          "forbidden",
        );
        expectProblem(await post("/v1/auth/mfa/challenge", { factorId: id }, bearer(weak)), 403, "forbidden");
      }
      // The account's own factor still works.
      const ok = await post("/v1/auth/mfa/verify", { factorId, code: FAKE_TOTP_CODE }, bearer(weak));
      expect(ok.json()).toMatchObject({ session: { aal: "aal2" } });
    } finally {
      fake.enforceAal = true;
    }
  });

  it("an account with no verified factor can verify only its own pending factor, not someone else's", async () => {
    const { res: a } = await confirmedUser("b1own");
    const { res: b } = await confirmedUser("b1other");
    const foreign = (
      (await post("/v1/auth/mfa/totp/enrol", undefined, bearer(b))).json() as { factorId: string }
    ).factorId;
    expectProblem(
      await post("/v1/auth/mfa/verify", { factorId: foreign, code: FAKE_TOTP_CODE }, bearer(a)),
      404,
      "not_found",
    );
    // Still not verified for its owner either: the foreign attempt changed nothing.
    const own = ((await post("/v1/auth/mfa/totp/enrol", undefined, bearer(a))).json() as { factorId: string })
      .factorId;
    expect(
      (await post("/v1/auth/mfa/verify", { factorId: own, code: FAKE_TOTP_CODE }, bearer(a))).statusCode,
    ).toBe(200);
  });

  it("password reset on an account with an authenticator never yields a session without the code, so reset-then-enrol is closed", async () => {
    const { email } = await enrolledUser("b1reset");
    for (const enforceAal of [true, false]) {
      fake.enforceAal = enforceAal;
      try {
        await post("/v1/auth/password-reset/request", { email });
        const mail = fake.lastMail(email, "recovery");
        const res = await post("/v1/auth/password-reset/confirm", {
          email,
          code: mail?.code,
          newPassword: "an attacker chosen passphrase",
        });
        expectProblem(res, 403, "mfa_required");
        expect(res.body).not.toContain("accessToken");
        expect(setCookies(res)).toEqual([]);
        // The password did not change.
        expect(
          (await post("/v1/auth/sign-in", { email, password: "an attacker chosen passphrase" })).statusCode,
        ).toBe(401);
        // A wrong code is refused too.
        await post("/v1/auth/password-reset/request", { email });
        const again = fake.lastMail(email, "recovery");
        expectProblem(
          await post("/v1/auth/password-reset/confirm", {
            email,
            code: again?.code,
            newPassword: "an attacker chosen passphrase",
            mfaCode: "000000",
          }),
          400,
          "bad_request",
        );
      } finally {
        fake.enforceAal = true;
      }
    }
  });
});

describe("provider email limits do not leak through the always-202 routes (S1)", () => {
  it("sign-up, resend and reset request answer 202 when Supabase rate-limits the address", async () => {
    fake.rateLimitEmails = true;
    try {
      for (const [url, payload] of [
        ["/v1/auth/sign-up", { firstName: "R", email: "limited@example.test", password: PASSWORD }],
        ["/v1/auth/resend-confirmation", { email: "limited@example.test" }],
        ["/v1/auth/password-reset/request", { email: "limited@example.test" }],
      ] as const) {
        const res = await post(url, payload);
        expect(res.statusCode, url).toBe(202);
        expect(res.json()).toEqual({ status: "accepted" });
      }
    } finally {
      fake.rateLimitEmails = false;
    }
  });
});

describe("guessing one address or account is limited whatever the IP (S2)", () => {
  const clocked = () => {
    let t = Date.now();
    const server = buildServerWithClock(() => t);
    return { server, advance: (ms: number) => (t += ms) };
  };
  const signIn = (s: ApiServer, email: string, password: string) =>
    s.inject({ method: "POST", url: "/v1/auth/sign-in", payload: { email, password } });

  it("5 wrong passwords lock that address, even for the right password, for 15 minutes; other addresses are unaffected", async () => {
    const { email } = await confirmedUser("s2lock");
    const { email: other } = await confirmedUser("s2other");
    const { server, advance } = clocked();
    await server.ready();
    for (let i = 0; i < 5; i++) expect((await signIn(server, email, "wrong-wrong-1")).statusCode).toBe(401);
    const locked = await signIn(server, email, PASSWORD);
    expectProblem(locked, 429, "rate_limited");
    expect(locked.headers["retry-after"]).toBeDefined();
    expect(locked.body).not.toContain(email);
    expect((await signIn(server, other, PASSWORD)).statusCode).toBe(200);
    // An unknown address is counted the same way, so the lockout does not reveal accounts.
    for (let i = 0; i < 5; i++) await signIn(server, "ghost@example.test", "wrong-wrong-1");
    expectProblem(await signIn(server, "ghost@example.test", "wrong-wrong-1"), 429, "rate_limited");
    advance(16 * 60 * 1000);
    expect((await signIn(server, email, PASSWORD)).statusCode).toBe(200);
    await server.close();
  });

  it("a success clears the count", async () => {
    const { email } = await confirmedUser("s2clear");
    const { server } = clocked();
    await server.ready();
    for (let i = 0; i < 4; i++) await signIn(server, email, "wrong-wrong-1");
    expect((await signIn(server, email, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await signIn(server, email, "wrong-wrong-1")).statusCode).toBe(401);
    await server.close();
  });

  it("wrong emailed codes are counted per address on confirm-email and password-reset/confirm", async () => {
    const email = `s2code-${randomUUID().slice(0, 8)}@example.test`;
    await post("/v1/auth/sign-up", { firstName: "C", email, password: PASSWORD });
    const mail = fake.lastMail(email, "signup");
    const { server } = clocked();
    await server.ready();
    const confirm = (code: string) =>
      server.inject({ method: "POST", url: "/v1/auth/confirm-email", payload: { email, code } });
    for (let i = 0; i < 5; i++) expect((await confirm("000000")).statusCode).toBe(400);
    expectProblem(await confirm(mail?.code ?? "123456"), 429, "rate_limited");

    const reset = (code: string) =>
      server.inject({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        payload: { email, code, newPassword: "a brand new passphrase" },
      });
    for (let i = 0; i < 5; i++) expect((await reset("000000")).statusCode).toBe(400);
    expectProblem(await reset("000000"), 429, "rate_limited");
    await server.close();
  });

  it("wrong authenticator codes are counted per account on mfa/verify", async () => {
    const { res } = await confirmedUser("s2mfa");
    const { factorId } = (await post("/v1/auth/mfa/totp/enrol", undefined, bearer(res))).json() as {
      factorId: string;
    };
    const { server } = clocked();
    await server.ready();
    const verify = (code: string) =>
      server.inject({
        method: "POST",
        url: "/v1/auth/mfa/verify",
        payload: { factorId, code },
        headers: bearer(res),
      });
    for (let i = 0; i < 5; i++) expect((await verify("000000")).statusCode).toBe(400);
    expectProblem(await verify(FAKE_TOTP_CODE), 429, "rate_limited");
    await server.close();
  });
});

describe("a password reset ends the other sessions (S3)", () => {
  it("other sessions' refresh tokens die; the new session works", async () => {
    const { email } = await confirmedUser("s3");
    const mobile = { "x-mp-client": "mobile" };
    const old = await post("/v1/auth/sign-in", { email, password: PASSWORD }, mobile);
    const oldRt = (old.json() as SessionBody).session.refreshToken;
    await post("/v1/auth/password-reset/request", { email });
    const mail = fake.lastMail(email, "recovery");
    const res = await post(
      "/v1/auth/password-reset/confirm",
      { email, code: mail?.code, newPassword: "a brand new passphrase" },
      mobile,
    );
    expect(res.statusCode).toBe(200);
    expect(fake.calls.some((c) => c.path === "/logout")).toBe(true);
    expectProblem(await post("/v1/auth/refresh", { refreshToken: oldRt }, mobile), 401, "unauthorized");
    const newRt = (res.json() as SessionBody).session.refreshToken;
    expect((await post("/v1/auth/refresh", { refreshToken: newRt }, mobile)).statusCode).toBe(200);
  });
});

describe("the mobile client is refused from a browser (S6)", () => {
  it("X-MP-Client: mobile with an Origin header is 400 on every route that mints a session", async () => {
    for (const [url, payload] of [
      ["/v1/auth/sign-in", { email: "a@example.test", password: PASSWORD }],
      ["/v1/auth/refresh", { refreshToken: "x" }],
      ["/v1/auth/confirm-email", { email: "a@example.test", code: "123456" }],
    ] as const) {
      const res = await post(url, payload, { "x-mp-client": "mobile", origin: WEB });
      expectProblem(res, 400, "validation_failed");
      expect(res.body).not.toContain('refreshToken":"');
    }
    // Without an Origin (a native app) it works as before.
    const { email } = await confirmedUser("s6");
    expect(
      (await post("/v1/auth/sign-in", { email, password: PASSWORD }, { "x-mp-client": "mobile" })).statusCode,
    ).toBe(200);
  });
});

function buildServerWithClock(now: () => number): ApiServer {
  const rt: ApiRuntime = { db, provider, inviteSender: { send: async () => undefined } };
  return buildServer({
    authenticate: createAuthenticator({ provider, db }),
    modules: [
      createIdentityModule(() => rt),
      createAuthModule(() => ({ gotrue: fake.gotrue(), config }), { now }),
    ],
    // The per-IP budgets are not under test here; the per-address failure limiter is.
    rateLimit: {
      groups: {
        authCredentials: { max: 10_000, timeWindow: "1 minute" },
        authSession: { max: 10_000, timeWindow: "1 minute" },
      },
    },
  });
}
