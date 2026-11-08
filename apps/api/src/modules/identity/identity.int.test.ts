// /v1/me over HTTP with a real database and the Supabase verifier against a fake issuer (ADR-020).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApi, type TestApi } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

const post = (headers: Record<string, string>, payload?: unknown) =>
  api.app.inject({
    method: "POST",
    url: "/v1/me/bootstrap",
    headers,
    payload: payload as object | undefined,
  });

describe("authentication on every request", () => {
  it("no token: 401", async () => {
    expectProblem(await api.app.inject({ url: "/v1/me" }), 401, "unauthorized");
  });

  it("malformed Authorization header: 401", async () => {
    for (const authorization of ["Basic abc", "Bearer", "Bearer a b", "bearer"]) {
      expectProblem(await api.app.inject({ url: "/v1/me", headers: { authorization } }), 401, "unauthorized");
    }
  });

  it.each([
    [
      "signed by another key",
      async () =>
        (await (await import("../../auth/testing/fake-supabase")).FakeSupabase.create()).accessToken("s"),
    ],
    [
      "wrong issuer",
      () => api.issuer.accessToken("s", { claims: { iss: "https://evil.supabase.co/auth/v1" } }),
    ],
    ["wrong audience", () => api.issuer.accessToken("s", { claims: { aud: "other" } })],
    ["the anon role", () => api.issuer.accessToken("s", { claims: { role: "anon" } })],
    ["an anonymous user", () => api.issuer.accessToken("s", { claims: { is_anonymous: true } })],
    ["expired", () => api.issuer.accessToken("s", { nowSeconds: Math.floor(Date.now() / 1000) - 9000 })],
  ])("%s: 401 on a normal route and on bootstrap", async (_name, makeToken) => {
    const headers = { authorization: `Bearer ${await makeToken()}` };
    expectProblem(await api.app.inject({ url: "/v1/me", headers }), 401, "unauthorized");
    expectProblem(await post(headers, { firstName: "X" }), 401, "unauthorized");
  });

  it("alg none: 401", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none", kid: api.issuer.kid })}.${b64({
      sub: "x",
      iss: api.issuer.issuer,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
      email: "x@example.test",
    })}.`;
    expectProblem(
      await api.app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${token}` } }),
      401,
      "unauthorized",
    );
  });
});

describe("POST /v1/me/bootstrap", () => {
  it("creates the user from the verified claims and returns the profile", async () => {
    const subject = `sub-new-${crypto.randomUUID()}`;
    const email = `new-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const headers = await api.as(subject, { claims: { email, mfa_enabled: true } });
    const res = await post(headers, { firstName: "Sam", lastName: "Rivera", timezone: "America/Chicago" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email,
      firstName: "Sam",
      lastName: "Rivera",
      timezone: "America/Chicago",
      mfaEnabled: true,
      memberships: [],
    });
    const me = await api.app.inject({ url: "/v1/me", headers });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { email: string }).email).toBe(email);
  });

  it("takes the email from the token, never the body", async () => {
    const headers = await api.as(`sub-body-${crypto.randomUUID()}`, {
      claims: { email: `body-${crypto.randomUUID().slice(0, 8)}@example.test` },
    });
    const res = await post(headers, { firstName: "Sam", email: "attacker@example.test" });
    expectProblem(res, 400, "validation_failed");
    const after = await post(headers, { firstName: "Sam" });
    expect((after.json() as { email: string }).email).not.toBe("attacker@example.test");
  });

  it("refuses a token whose email_verified is false, and creates nothing", async () => {
    const subject = `sub-unverified-${crypto.randomUUID()}`;
    const headers = await api.as(subject, { claims: { email_verified: false } });
    expectProblem(await post(headers, { firstName: "Sam" }), 403, "forbidden");
    // Still no row: /me says to bootstrap first.
    expectProblem(await api.app.inject({ url: "/v1/me", headers }), 403, "forbidden");
  });

  it("refuses when email_verified is missing or the email claim is missing", async () => {
    expectProblem(
      await post(await api.as(`s-${crypto.randomUUID()}`, { claims: { email_verified: undefined } }), {
        firstName: "S",
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await post(await api.as(`s-${crypto.randomUUID()}`, { claims: { email: undefined } }), {
        firstName: "S",
      }),
      403,
      "forbidden",
    );
  });

  it("needs a first name the first time only", async () => {
    const headers = await api.as(`sub-name-${crypto.randomUUID()}`, {
      claims: { email: `n-${crypto.randomUUID().slice(0, 8)}@example.test` },
    });
    const problem = expectProblem(await post(headers), 400, "validation_failed");
    expect(problem.fields?.[0]?.path).toBe("firstName");
    expect((await post(headers, { firstName: "Ana" })).statusCode).toBe(200);
    expect((await post(headers)).statusCode).toBe(200);
  });

  it("syncs a changed email and MFA flag from the token on a later call", async () => {
    const subject = `sub-sync-${crypto.randomUUID()}`;
    const first = `sync-a-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const second = `sync-b-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await post(await api.as(subject, { claims: { email: first, mfa_enabled: false } }), { firstName: "Syd" });
    const res = await post(await api.as(subject, { claims: { email: second, mfa_enabled: true } }));
    expect(res.json()).toMatchObject({ email: second, mfaEnabled: true });
  });

  it("does NOT sync an unverified email change", async () => {
    const subject = `sub-nosync-${crypto.randomUUID()}`;
    const email = `ns-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await post(await api.as(subject, { claims: { email } }), { firstName: "Nia" });
    const bad = await post(
      await api.as(subject, { claims: { email: "takeover@example.test", email_verified: false } }),
    );
    expect(bad.statusCode).toBe(403);
    const me = await api.app.inject({ url: "/v1/me", headers: await api.as(subject, { claims: { email } }) });
    expect((me.json() as { email: string }).email).toBe(email);
    const stored = await api.admin(
      async (c) =>
        (await c.query("select email::text as email from users where auth_subject = $1", [subject])).rows,
    );
    expect(stored).toEqual([{ email }]);
  });

  it("409 when another account already owns the email", async () => {
    const taken = await api.signUp("taken");
    const headers = await api.as(`sub-dup-${crypto.randomUUID()}`, { claims: { email: taken.email } });
    expectProblem(await post(headers, { firstName: "Dup" }), 409, "conflict");
  });

  it("writes a user.created audit event once", async () => {
    const user = await api.signUp("audit");
    await post(user.headers);
    const rows = await api.admin(
      async (c) =>
        (
          await c.query(
            "select count(*)::int as n from audit_events where actor_user_id = $1 and action = 'user.created'",
            [user.id],
          )
        ).rows,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("PATCH /v1/me", () => {
  it("updates name and time zone; rejects an email field and bad zones", async () => {
    const user = await api.signUp("patch");
    const ok = await api.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: user.headers,
      payload: { firstName: "Pat", timezone: "America/Denver" },
    });
    expect(ok.json()).toMatchObject({ firstName: "Pat", timezone: "America/Denver", email: user.email });
    for (const payload of [{ email: "x@example.test" }, { timezone: "Mars/Base" }, {}]) {
      expectProblem(
        await api.app.inject({ method: "PATCH", url: "/v1/me", headers: user.headers, payload }),
        400,
        "validation_failed",
      );
    }
  });
});
