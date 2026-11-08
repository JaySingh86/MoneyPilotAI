// WP-21 against a real Postgres (RLS as mp_api) with the fake Gmail and Graph: OAuth start (step-up, PKCE, state),
// the callback, the owner-only management routes, the household summary and leave hook, and both push webhooks.
// No network, no real inbox.
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataKeyGenerator } from "@mp/crypto/encrypt";
import { graphClientState, ProviderError } from "@mp/email/oauth";
import { createFakeGmail, createFakeGraph, gmailPushBody, type FakeMailProvider } from "@mp/email/testing";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";
import { createEmailModules, type EmailConfig } from "./index";

const WEB = "https://app.moneypilot.test";
const AUDIENCE = "https://api.moneypilot.test/webhooks/gmail";
const SA = "gmail-push@moneypilot-dev.iam.gserviceaccount.com";
const MASTER = randomBytes(32);
const HASH_KEY = randomBytes(32);
const GRAPH_SECRET = randomBytes(32);
const ENV = { NODE_ENV: "test", TOKEN_MASTER_KEY: MASTER.toString("base64") };

let t: TestApi;
let gmail: FakeMailProvider;
let graph: FakeMailProvider;
let jwks: JWTVerifyGetKey;
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signer: Key;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signer = privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  gmail = createFakeGmail();
  graph = createFakeGraph();
  const config: EmailConfig = {
    providers: (id) => (id === "gmail" ? gmail : graph),
    keys: createDataKeyGenerator(ENV),
    addressHashKey: HASH_KEY,
    graphStateSecret: GRAPH_SECRET,
    webOrigin: WEB,
    gmailPush: { audience: AUDIENCE, serviceAccountEmail: SA, jwks },
  };
  t = await createTestApi({ extraModules: (rt) => createEmailModules(() => rt, { config }) });
}, 180_000);
afterAll(async () => {
  await t?.close();
});

async function household(label = "Email"): Promise<{ owner: TestUser; hid: string }> {
  const owner = await t.signUp(`${label}-owner`);
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...owner.headers, ...key() },
    payload: { name: label },
  });
  expect(res.statusCode).toBe(201);
  return { owner, hid: (res.json() as { id: string }).id };
}

async function addPartner(owner: TestUser, hid: string): Promise<TestUser> {
  const partner = await t.signUp("email-partner");
  const inv = await t.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/invites`,
    headers: { ...owner.headers, ...key() },
    payload: { email: partner.email },
  });
  expect(inv.statusCode).toBe(201);
  const acc = await t.app.inject({
    method: "POST",
    url: "/v1/invites/accept",
    headers: partner.headers,
    payload: { token: t.sent.at(-1)?.token ?? "" },
  });
  expect(acc.statusCode).toBe(200);
  return partner;
}

const start = (
  user: TestUser,
  provider: "gmail" | "outlook",
  returnTo: unknown = "/imports",
  headers = user.headers,
) =>
  t.app.inject({
    method: "POST",
    url: `/v1/email-connections/${provider}/start`,
    headers,
    payload: { returnTo },
  });

/** The whole happy path: start, the person consents in the (fake) provider, the browser comes back to the callback. */
async function connect(
  user: TestUser,
  address: string,
  options: { provider?: "gmail" | "outlook"; returnTo?: "/imports" | "/setup" } = {},
) {
  const provider = options.provider ?? "gmail";
  const fake = provider === "gmail" ? gmail : graph;
  const res = await start(user, provider, options.returnTo ?? "/imports");
  expect(res.statusCode, res.body).toBe(200);
  const authUrl = (res.json() as { authUrl: string }).authUrl;
  const { code, state } = fake.consent(authUrl, address);
  const cb = await t.app.inject({
    method: "GET",
    url: `/v1/email-connections/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers: cookieHeader(res),
  });
  return { cb, code, state, authUrl, startRes: res };
}

/** The cookie the browser keeps from `start` and sends back to the callback. */
const cookieHeader = (res: { headers: Record<string, unknown> }): Record<string, string> => {
  const raw = res.headers["set-cookie"];
  const first = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] ?? "";
  return { cookie: first };
};
const location = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers["location"]));
const addr = (label: string) => `${label}-${randomBytes(3).toString("hex")}@gmail.com`;

describe("start (OAuth with PKCE and server-side state)", () => {
  it("requires a recent second-factor sign-in, before anything is stored", async () => {
    const { owner } = await household();
    const weak = await t.as(owner.subject, { claims: { email: owner.email, mfa_verified_at: undefined } });
    const before = await t.admin((c) => c.query("select count(*)::int as n from email_oauth_states"));
    expectProblem(await start(owner, "gmail", "/imports", weak), 403, "mfa_required");
    const stale = await t.as(owner.subject, {
      claims: { email: owner.email, mfa_verified_at: Math.floor(Date.now() / 1000) - 601 },
    });
    expectProblem(await start(owner, "gmail", "/imports", stale), 403, "mfa_required");
    const after = await t.admin((c) => c.query("select count(*)::int as n from email_oauth_states"));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("needs a sign-in", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/email-connections/gmail/start",
      payload: { returnTo: "/imports" },
    });
    expectProblem(res, 401, "unauthorized");
  });

  it("returnTo is a closed list: anything else, including a URL, is refused", async () => {
    const { owner } = await household();
    for (const bad of ["/settings", "https://evil.example", "//evil.example", "/imports?x=1", "", null, 5]) {
      expectProblem(await start(owner, "gmail", bad), 400, "validation_failed");
    }
    const extra = await t.app.inject({
      method: "POST",
      url: "/v1/email-connections/gmail/start",
      headers: owner.headers,
      payload: { returnTo: "/imports", redirect: "https://evil.example" },
    });
    expectProblem(extra, 400, "validation_failed");
    expectProblem(await start(owner, "yahoo" as never), 400, "validation_failed");
  });

  it("returns a consent URL with PKCE S256 and a state that is stored only as a hash", async () => {
    const { owner } = await household();
    const res = await start(owner, "gmail", "/setup");
    expect(res.statusCode).toBe(200);
    const url = new URL((res.json() as { authUrl: string }).authUrl);
    const state = url.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const rows = await t.admin((c) =>
      c.query(
        "select state_hash, return_to, code_verifier, expires_at - created_at as ttl from email_oauth_states where user_id = $1",
        [owner.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row.state_hash.equals(createHash("sha256").update(state).digest())).toBe(true);
    expect(row.return_to).toBe("/setup");
    // The challenge sent to the provider is the hash of the verifier we kept.
    expect(createHash("sha256").update(row.code_verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(row.ttl.minutes).toBe(10);
  });

  it("is never stored for replay (the URL carries the state)", async () => {
    const { owner } = await household();
    const k = key();
    const a = await t.app.inject({
      method: "POST",
      url: "/v1/email-connections/gmail/start",
      headers: { ...owner.headers, ...k },
      payload: { returnTo: "/imports" },
    });
    const b = await t.app.inject({
      method: "POST",
      url: "/v1/email-connections/gmail/start",
      headers: { ...owner.headers, ...k },
      payload: { returnTo: "/imports" },
    });
    expect((a.json() as { authUrl: string }).authUrl).not.toBe((b.json() as { authUrl: string }).authUrl);
  });

  it("a person without a household cannot start", async () => {
    const lone = await t.signUp("email-lone");
    expectProblem(await start(lone, "gmail"), 409, "conflict");
  });

  it("answers 503 for a provider that is not configured", async () => {
    const off = await createTestApi({
      extraModules: (rt) => createEmailModules(() => rt, { config: null }),
    });
    try {
      const u = await off.signUp("email-off");
      const res = await off.app.inject({
        method: "POST",
        url: "/v1/email-connections/gmail/start",
        headers: u.headers,
        payload: { returnTo: "/imports" },
      });
      expectProblem(res, 503, "internal_error");
      const hook = await off.app.inject({
        method: "POST",
        url: "/webhooks/graph",
        payload: { value: [{ clientState: "x" }] },
      });
      expect(hook.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});

describe("callback", () => {
  it("stores a sealed token, redirects to the web app and lists a masked connection", async () => {
    const { owner, hid } = await household();
    const address = addr("samantha");
    const { cb } = await connect(owner, address);
    expect(cb.statusCode).toBe(302);
    const to = location(cb);
    expect(to.origin + to.pathname).toBe(`${WEB}/imports`);
    expect(to.searchParams.get("connected")).toBe("gmail");
    expect(cb.headers["cache-control"]).toBe("no-store");

    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/email-connections`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { data: Record<string, unknown>[]; nextCursor: null };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      provider: "gmail",
      ownerUserId: owner.id,
      maskedAddress: `${address.slice(0, 3)}•••@gmail.com`,
      status: "connected",
      lastCheckedAt: null,
      backfillMonths: 13,
      matchedCount: 0,
      usedCount: 0,
    });
    // Nothing secret or identifying is on the wire.
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual(
      [
        "backfillMonths",
        "id",
        "lastCheckedAt",
        "matchedCount",
        "maskedAddress",
        "ownerUserId",
        "provider",
        "status",
        "usedCount",
      ].sort(),
    );
    expect(list.body).not.toContain(address);
    expect(list.body.toLowerCase()).not.toContain("token");

    const row = await t.admin((c) =>
      c.query(
        "select id, token_ciphertext, token_dek_wrapped, token_key_id, address_hash, scopes from email_connections where household_id = $1",
        [hid],
      ),
    );
    const r = row.rows[0];
    // The refresh token is stored sealed: no plaintext in any column. (Only the worker may open it; the round trip
    // with the worker's key is covered in packages/crypto and the worker tests.)
    expect(r.token_key_id).toMatch(/^local:/);
    expect(Buffer.from(r.token_ciphertext).includes(Buffer.from("rt-"))).toBe(false);
    expect(Buffer.from(r.token_dek_wrapped).includes(Buffer.from("rt-"))).toBe(false);
    expect(r.token_ciphertext[0]).toBe(1); // envelope version byte
    expect(r.address_hash).toHaveLength(32);
    expect(r.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    // No plaintext address anywhere in the row.
    expect(JSON.stringify(r)).not.toContain(address);

    const audit = await t.admin((c) =>
      c.query(
        "select action, metadata from audit_events where household_id = $1 and action = 'email.connected'",
        [hid],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0])).not.toContain(address);
  });

  it("returns to /setup when that is where the person started", async () => {
    const { owner } = await household();
    const { cb } = await connect(owner, addr("setup"), { returnTo: "/setup" });
    expect(location(cb).pathname).toBe("/setup");
    expect(location(cb).searchParams.get("connected")).toBe("gmail");
  });

  it("connects Outlook with a Microsoft address and keeps the rotated-token provider contract", async () => {
    const { owner, hid } = await household();
    const { cb } = await connect(owner, "jordan.rivera@outlook.com", { provider: "outlook" });
    expect(location(cb).searchParams.get("connected")).toBe("outlook");
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/email-connections`,
      headers: owner.headers,
    });
    expect((list.json() as { data: { maskedAddress: string }[] }).data[0]?.maskedAddress).toBe(
      "jor•••@outlook.com",
    );
  });

  it("a state works once", async () => {
    const { owner, hid } = await household();
    const { cb, code, state } = await connect(owner, addr("once"));
    expect(location(cb).searchParams.get("connected")).toBe("gmail");
    const again = await t.app.inject({
      method: "GET",
      url: `/v1/email-connections/gmail/callback?code=${code}&state=${state}`,
    });
    expect(again.statusCode).toBe(302);
    expect(location(again).searchParams.get("connect_error")).toBe("invalid_state");
    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("an unknown, missing, expired or wrong-provider state stores nothing", async () => {
    const { owner, hid } = await household();
    const res = await start(owner, "gmail");
    const authUrl = (res.json() as { authUrl: string }).authUrl;
    const { code, state } = gmail.consent(authUrl, addr("bad"));
    const get = (qs: string, provider = "gmail") =>
      t.app.inject({ method: "GET", url: `/v1/email-connections/${provider}/callback?${qs}` });

    expect(
      location(await get(`code=${code}&state=${"A".repeat(43)}`)).searchParams.get("connect_error"),
    ).toBe("invalid_state");
    expect(location(await get(`code=${code}`)).searchParams.get("connect_error")).toBe("invalid_state");
    // A Gmail state replayed against the Outlook callback.
    expect(
      location(await get(`code=${code}&state=${state}`, "outlook")).searchParams.get("connect_error"),
    ).toBe("invalid_state");

    const second = await start(owner, "gmail");
    const s2 = new URL((second.json() as { authUrl: string }).authUrl).searchParams.get("state") ?? "";
    await t.admin((c) =>
      c.query(
        "update email_oauth_states set expires_at = now() - interval '1 second' where state_hash = $1",
        [createHash("sha256").update(s2).digest()],
      ),
    );
    const c2 = gmail.consent((second.json() as { authUrl: string }).authUrl, addr("late"));
    expect(location(await get(`code=${c2.code}&state=${s2}`)).searchParams.get("connect_error")).toBe(
      "invalid_state",
    );

    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("the person declining the consent screen comes back with access_denied, and the state is burnt", async () => {
    const { owner, hid } = await household();
    const res = await start(owner, "gmail", "/setup");
    const state = new URL((res.json() as { authUrl: string }).authUrl).searchParams.get("state") ?? "";
    const cb = await t.app.inject({
      method: "GET",
      url: `/v1/email-connections/gmail/callback?error=access_denied&state=${state}`,
      headers: cookieHeader(res),
    });
    expect(location(cb).pathname).toBe("/setup");
    expect(location(cb).searchParams.get("connect_error")).toBe("access_denied");
    const again = await t.app.inject({
      method: "GET",
      url: `/v1/email-connections/gmail/callback?code=x&state=${state}`,
    });
    expect(location(again).searchParams.get("connect_error")).toBe("invalid_state");
    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("a code the provider refuses, or a grant without the right scope, stores nothing and says why", async () => {
    const { owner, hid } = await household();
    gmail.failNext("exchangeCode", new ProviderError("auth_revoked", "refused"));
    expect(location((await connect(owner, addr("x1"))).cb).searchParams.get("connect_error")).toBe(
      "exchange_failed",
    );
    gmail.failNext("exchangeCode", new ProviderError("permanent", "no scope"));
    expect(location((await connect(owner, addr("x2"))).cb).searchParams.get("connect_error")).toBe(
      "scope_missing",
    );
    gmail.failNext("exchangeCode", new ProviderError("transient", "down"));
    expect(location((await connect(owner, addr("x3"))).cb).searchParams.get("connect_error")).toBe(
      "unavailable",
    );
    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("the same mailbox cannot be connected twice by one member", async () => {
    const { owner, hid } = await household();
    const address = addr("dup");
    expect(location((await connect(owner, address)).cb).searchParams.get("connected")).toBe("gmail");
    expect(location((await connect(owner, address)).cb).searchParams.get("connect_error")).toBe(
      "already_connected",
    );
    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("the connection belongs to whoever started it, not to the browser that arrives", async () => {
    const { owner, hid } = await household();
    const partner = await addPartner(owner, hid);
    const { cb } = await connect(partner, addr("partnerbox"));
    expect(location(cb).searchParams.get("connected")).toBe("gmail");
    const rows = await t.admin((c) =>
      c.query("select user_id from email_connections where household_id = $1", [hid]),
    );
    expect(rows.rows.map((r) => r.user_id)).toEqual([partner.id]);
  });
});

describe("callback binding to the starting browser (S1: login CSRF, consent phishing)", () => {
  it("sets a short-lived HttpOnly SameSite=Lax cookie scoped to the callback, and clears it on return", async () => {
    const { owner } = await household();
    const res = await start(owner, "gmail");
    const raw = String(res.headers["set-cookie"]);
    expect(raw).toMatch(/^mp_email_oauth_gmail=[A-Za-z0-9_-]{43};/);
    expect(raw).toContain("Path=/v1/email-connections/gmail/callback");
    expect(raw).toContain("Max-Age=600");
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    // No TLS on localhost, so no Secure there; everywhere else it is Secure.
    expect(raw).not.toContain("Secure");
    const remote = await t.app.inject({
      method: "POST",
      url: "/v1/email-connections/gmail/start",
      headers: { ...owner.headers, host: "api.moneypilot.test" },
      payload: { returnTo: "/imports" },
    });
    expect(String(remote.headers["set-cookie"])).toContain("Secure");
    // The nonce is not in the URL or the response body, and the database holds only its hash.
    const nonce = /=([^;]+)/.exec(raw)?.[1] ?? "";
    expect(res.body).not.toContain(nonce);
    const rows = await t.admin((c) =>
      c.query("select browser_hash from email_oauth_states where user_id = $1", [owner.id]),
    );
    expect(rows.rows[0].browser_hash.equals(createHash("sha256").update(nonce).digest())).toBe(true);

    const cleared = await connect(owner, addr("clear"));
    const setCookie = String(cleared.cb.headers["set-cookie"]);
    expect(setCookie).toMatch(/^mp_email_oauth_gmail=;/);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("a valid state without the cookie fails with invalid_state, stores nothing and burns the state", async () => {
    const { owner, hid } = await household();
    const res = await start(owner, "gmail");
    const { code, state } = gmail.consent((res.json() as { authUrl: string }).authUrl, addr("phish"));
    const url = `/v1/email-connections/gmail/callback?code=${code}&state=${state}`;
    // The attacker's link, opened in the victim's browser: no cookie.
    const stolen = await t.app.inject({ method: "GET", url });
    expect(location(stolen).searchParams.get("connect_error")).toBe("invalid_state");
    // Even the real browser cannot use it afterwards.
    const late = await t.app.inject({ method: "GET", url, headers: cookieHeader(res) });
    expect(location(late).searchParams.get("connect_error")).toBe("invalid_state");
    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("a cookie from another flow, a malformed cookie or another provider's cookie does not match", async () => {
    const { owner, hid } = await household();
    const other = await start(owner, "gmail");
    for (const cookie of [
      cookieHeader(other).cookie,
      "mp_email_oauth_gmail=short",
      "mp_email_oauth_outlook=" + "A".repeat(43),
      "",
    ]) {
      const res = await start(owner, "gmail");
      const { code, state } = gmail.consent((res.json() as { authUrl: string }).authUrl, addr("mismatch"));
      const cb = await t.app.inject({
        method: "GET",
        url: `/v1/email-connections/gmail/callback?code=${code}&state=${state}`,
        headers: cookie ? { cookie } : {},
      });
      expect(location(cb).searchParams.get("connect_error"), cookie).toBe("invalid_state");
    }
    const n = await t.admin((c) =>
      c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("does not exchange the code for a request that failed the binding", async () => {
    const { owner } = await household();
    const res = await start(owner, "gmail");
    const { code, state } = gmail.consent((res.json() as { authUrl: string }).authUrl, addr("noexchange"));
    const before = gmail.count("exchangeCode");
    await t.app.inject({
      method: "GET",
      url: `/v1/email-connections/gmail/callback?code=${code}&state=${state}`,
    });
    expect(gmail.count("exchangeCode")).toBe(before);
  });
});

describe("a grant we cannot keep is not left at the provider (S4)", () => {
  async function failing(label: string, keys: EmailConfig["keys"]) {
    const config: EmailConfig = {
      providers: (id) => (id === "gmail" ? gmail : graph),
      keys,
      addressHashKey: HASH_KEY,
      graphStateSecret: GRAPH_SECRET,
      webOrigin: WEB,
      gmailPush: null,
    };
    const app = await createTestApi({ extraModules: (rt) => createEmailModules(() => rt, { config }) });
    const owner = await app.signUp(label);
    const hh = await app.app.inject({
      method: "POST",
      url: "/v1/households",
      headers: { ...owner.headers, ...key() },
      payload: { name: label },
    });
    return { app, owner, hid: (hh.json() as { id: string }).id };
  }
  async function run(app: TestApi, owner: TestUser, address: string) {
    const res = await app.app.inject({
      method: "POST",
      url: "/v1/email-connections/gmail/start",
      headers: owner.headers,
      payload: { returnTo: "/imports" },
    });
    const { code, state } = gmail.consent((res.json() as { authUrl: string }).authUrl, address);
    return app.app.inject({
      method: "GET",
      url: `/v1/email-connections/gmail/callback?code=${code}&state=${state}`,
      headers: cookieHeader(res),
    });
  }

  it("a sealing failure revokes the new grant and stores nothing", async () => {
    const { app, owner, hid } = await failing("sealfail", {
      keyId: () => "x",
      generateDataKey: async () => {
        throw new Error("kms down");
      },
    });
    try {
      const address = addr("seal");
      const cb = await run(app, owner, address);
      expect(location(cb).searchParams.get("connect_error")).toBe("unavailable");
      expect(gmail.isRevoked(address)).toBe(true);
      const n = await app.admin((c) =>
        c.query("select count(*)::int as n from email_connections where household_id = $1", [hid]),
      );
      expect(n.rows[0].n).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("an insert failure revokes the new grant", async () => {
    const generator = createDataKeyGenerator(ENV);
    const { app, owner } = await failing("insertfail", {
      keyId: () => generator.keyId(),
      // A key id that breaks the column's length check, so the insert is refused after the code was exchanged.
      generateDataKey: async (ctx) => ({ ...(await generator.generateDataKey(ctx)), keyId: "k".repeat(300) }),
    });
    try {
      const address = addr("insert");
      expect(location(await run(app, owner, address)).searchParams.get("connect_error")).toBe("unavailable");
      expect(gmail.isRevoked(address)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a revoke that itself fails does not change the answer", async () => {
    const { app, owner } = await failing("revokefail", {
      keyId: () => "x",
      generateDataKey: async () => {
        throw new Error("kms down");
      },
    });
    try {
      gmail.failNext("revoke", new ProviderError("transient", "down"));
      expect(location(await run(app, owner, addr("rf"))).searchParams.get("connect_error")).toBe(
        "unavailable",
      );
    } finally {
      await app.close();
    }
  });

  it("a mailbox that is already connected keeps its working grant (revoking would end it)", async () => {
    const { owner } = await household();
    const address = addr("keep");
    expect(location((await connect(owner, address)).cb).searchParams.get("connected")).toBe("gmail");
    const revokes = gmail.count("revoke");
    expect(location((await connect(owner, address)).cb).searchParams.get("connect_error")).toBe(
      "already_connected",
    );
    expect(gmail.count("revoke")).toBe(revokes);
    expect(gmail.isRevoked(address)).toBe(false);
  });
});

describe("response headers", () => {
  it("every response, the Graph handshake included, says nosniff", async () => {
    const handshake = await t.app.inject({
      method: "POST",
      url: "/webhooks/graph?validationToken=abc",
      headers: { "content-type": "text/plain" },
    });
    expect(handshake.headers["x-content-type-options"]).toBe("nosniff");
    const health = await t.app.inject({ method: "GET", url: "/health" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("managing a connection (owner only)", () => {
  async function connected() {
    const { owner, hid } = await household();
    const partner = await addPartner(owner, hid);
    await connect(owner, addr("owner"));
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/email-connections`,
      headers: owner.headers,
    });
    const id = (list.json() as { data: { id: string }[] }).data[0]?.id ?? "";
    return { owner, partner, hid, id };
  }
  const post = (user: TestUser, path: string) =>
    t.app.inject({
      method: "POST",
      url: `/v1/email-connections/${path}`,
      headers: { ...user.headers, ...key() },
    });

  it("the partner sees the connection but cannot pause, resume or disconnect it", async () => {
    const { partner, hid, id } = await connected();
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/email-connections`,
      headers: partner.headers,
    });
    expect((list.json() as { data: unknown[] }).data).toHaveLength(1);
    expectProblem(await post(partner, `${id}/pause`), 403, "forbidden");
    expectProblem(await post(partner, `${id}/resume`), 403, "forbidden");
    expectProblem(
      await t.app.inject({ method: "DELETE", url: `/v1/email-connections/${id}`, headers: partner.headers }),
      403,
      "forbidden",
    );
    const row = await t.admin((c) => c.query("select status from email_connections where id = $1", [id]));
    expect(row.rows[0].status).toBe("active");
  });

  it("someone outside the household cannot see or change it", async () => {
    const { id } = await connected();
    const stranger = await t.signUp("email-stranger");
    expectProblem(await post(stranger, `${id}/pause`), 404, "not_found");
    expectProblem(
      await t.app.inject({ method: "DELETE", url: `/v1/email-connections/${id}`, headers: stranger.headers }),
      404,
      "not_found",
    );
    const other = await household("Other");
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${other.hid}/email-connections`,
      headers: other.owner.headers,
    });
    expect((list.json() as { data: unknown[] }).data).toHaveLength(0);
    const peek = await t.app.inject({
      method: "GET",
      url: `/v1/households/${other.hid}/email-connections`,
      headers: stranger.headers,
    });
    expectProblem(peek, 404, "not_found");
  });

  it("the owner pauses and resumes, and each is audited", async () => {
    const { owner, hid, id } = await connected();
    const paused = await post(owner, `${id}/pause`);
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { status: string }).status).toBe("paused");
    expectProblem(await post(owner, `${id}/pause`), 409, "conflict");
    const resumed = await post(owner, `${id}/resume`);
    expect((resumed.json() as { status: string }).status).toBe("connected");
    const actions = await t.admin((c) =>
      c.query(
        "select action from email_connections c, audit_events a where c.id = $1 and a.entity_id = c.id order by a.id",
        [id],
      ),
    );
    expect(actions.rows.map((r) => r.action)).toEqual(["email.connected", "email.paused", "email.resumed"]);
    expect(hid).toBeTruthy();
  });

  it("disconnect hides the connection, keeps the row for the worker to revoke, and is idempotent", async () => {
    const { owner, hid, id } = await connected();
    const del = await t.app.inject({
      method: "DELETE",
      url: `/v1/email-connections/${id}`,
      headers: { ...owner.headers, ...key() },
    });
    expect(del.statusCode).toBe(204);
    const row = await t.admin((c) =>
      c.query(
        "select status, revoked_at, token_ciphertext is not null as has_token from email_connections where id = $1",
        [id],
      ),
    );
    // The API cannot read the token, so it cannot delete it: the worker does (job email.revoke).
    expect(row.rows[0]).toMatchObject({ status: "revoked", has_token: true });
    expect(row.rows[0].revoked_at).toBeInstanceOf(Date);
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/email-connections`,
      headers: owner.headers,
    });
    expect((list.json() as { data: unknown[] }).data).toHaveLength(0);
    expect(
      (await t.app.inject({ method: "DELETE", url: `/v1/email-connections/${id}`, headers: owner.headers }))
        .statusCode,
    ).toBe(204);
    const audit = await t.admin((c) =>
      c.query(
        "select count(*)::int as n from audit_events where entity_id = $1 and action = 'email.disconnected'",
        [id],
      ),
    );
    expect(audit.rows[0].n).toBe(1);
    expectProblem(await post(owner, `${id}/resume`), 404, "not_found");
  });
});

describe("the household summary and the leave hook (WP-05)", () => {
  it("the summary reports the real connection count", async () => {
    const { owner, hid } = await household();
    const summary = async () =>
      (
        (
          await t.app.inject({ method: "GET", url: `/v1/households/${hid}/summary`, headers: owner.headers })
        ).json() as { connections: { emailConnections: number } }
      ).connections.emailConnections;
    expect(await summary()).toBe(0);
    await connect(owner, addr("a"));
    await connect(owner, addr("b"), { provider: "outlook" });
    expect(await summary()).toBe(2);
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/email-connections`,
      headers: owner.headers,
    });
    const id = (list.json() as { data: { id: string }[] }).data[0]?.id ?? "";
    await t.app.inject({
      method: "POST",
      url: `/v1/email-connections/${id}/pause`,
      headers: { ...owner.headers, ...key() },
    });
    expect(await summary()).toBe(1);
  });

  it("leaving revokes the leaver's connections and only theirs", async () => {
    const { owner, hid } = await household();
    const partner = await addPartner(owner, hid);
    await connect(owner, addr("stay"));
    await connect(partner, addr("leave1"));
    await connect(partner, addr("leave2"), { provider: "outlook" });
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/leave`,
      headers: { ...partner.headers, ...key() },
    });
    expect(res.statusCode).toBe(204);
    const rows = await t.admin((c) =>
      c.query("select user_id, status from email_connections where household_id = $1 order by created_at", [
        hid,
      ]),
    );
    expect(rows.rows).toEqual([
      { user_id: owner.id, status: "active" },
      { user_id: partner.id, status: "revoked" },
      { user_id: partner.id, status: "revoked" },
    ]);
    const audit = await t.admin((c) =>
      c.query(
        "select count(*)::int as n from audit_events where household_id = $1 and action = 'email.disconnected' and actor_user_id = $2",
        [hid, partner.id],
      ),
    );
    expect(audit.rows[0].n).toBe(2);
  });
});

describe("push webhooks", () => {
  async function connection(provider: "gmail" | "outlook" = "gmail") {
    const { owner, hid } = await household("Push");
    const address =
      provider === "gmail" ? addr("push") : `push-${randomBytes(3).toString("hex")}@outlook.com`;
    await connect(owner, address, { provider });
    const id = (
      await t.admin((c) => c.query("select id from email_connections where household_id = $1", [hid]))
    ).rows[0].id as string;
    return { address, id };
  }
  const pushedAt = async (id: string) =>
    (await t.admin((c) => c.query("select push_received_at from email_connections where id = $1", [id])))
      .rows[0].push_received_at as Date | null;

  async function googleToken(
    claims: Record<string, unknown> = {},
    over: { aud?: string; iss?: string; key?: Key } = {},
  ) {
    return new SignJWT({ email: SA, email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(over.iss ?? "https://accounts.google.com")
      .setAudience(over.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(over.key ?? signer);
  }
  const gmailPush = (token: string | undefined, body: unknown) =>
    t.app.inject({
      method: "POST",
      url: "/webhooks/gmail",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  it("Gmail: a push with Google's token for our audience and service account marks the connection", async () => {
    const { address, id } = await connection();
    expect(await pushedAt(id)).toBeNull();
    const res = await gmailPush(await googleToken(), gmailPushBody(address, "123"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "queued" });
    expect(await pushedAt(id)).toBeInstanceOf(Date);
  });

  it("Gmail: no token, a forged token, another audience, another service account or an unverified email are refused", async () => {
    const { address, id } = await connection();
    const body = gmailPushBody(address, "1");
    const other = await generateKeyPair("RS256");
    const attempts: (string | undefined)[] = [
      undefined,
      "not-a-jwt",
      await googleToken({}, { key: other.privateKey }),
      await googleToken({}, { aud: "https://evil.example/webhooks/gmail" }),
      await googleToken({ email: "attacker@evil.example" }),
      await googleToken({ email_verified: false }),
      await googleToken({}, { iss: "https://evil.example" }),
    ];
    for (const token of attempts) {
      expectProblem(await gmailPush(token, body), 401, "unauthorized");
    }
    expect(await pushedAt(id)).toBeNull();
  });

  it("Gmail: a verified push for an unknown mailbox is acknowledged and ignored; a bad body is a 400", async () => {
    const res = await gmailPush(await googleToken(), gmailPushBody("nobody@gmail.com", "1"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });
    expectProblem(
      await gmailPush(await googleToken(), { message: { data: Buffer.from("not json").toString("base64") } }),
      400,
      "validation_failed",
    );
    expectProblem(await gmailPush(await googleToken(), {}), 400, "validation_failed");
  });

  it("Gmail: a paused connection is not marked", async () => {
    const { owner, hid } = await household("PushPaused");
    const address = addr("paused");
    await connect(owner, address);
    const id = (
      await t.admin((c) => c.query("select id from email_connections where household_id = $1", [hid]))
    ).rows[0].id as string;
    await t.app.inject({
      method: "POST",
      url: `/v1/email-connections/${id}/pause`,
      headers: { ...owner.headers, ...key() },
    });
    expect((await gmailPush(await googleToken(), gmailPushBody(address, "1"))).json()).toEqual({
      status: "ignored",
    });
    expect(await pushedAt(id)).toBeNull();
  });

  it("Graph: answers the validation handshake with the token as text/plain, and nothing else is read", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/webhooks/graph?validationToken=Validation%3A+abc%20123",
      headers: { "content-type": "text/plain" },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/plain");
    expect(res.body).toBe("Validation: abc 123");
  });

  it("Graph: a notification with our clientState marks the connection and answers 202", async () => {
    const { id } = await connection("outlook");
    const res = await t.app.inject({
      method: "POST",
      url: "/webhooks/graph",
      payload: {
        value: [
          {
            subscriptionId: "s",
            clientState: graphClientState(GRAPH_SECRET, id),
            resource: "x",
            changeType: "created",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await pushedAt(id)).toBeInstanceOf(Date);
  });

  it("Graph: a wrong clientState, another secret, or a batch with one bad item marks nothing", async () => {
    const { id } = await connection("outlook");
    const other = await connection("outlook");
    const post = (value: unknown[]) =>
      t.app.inject({ method: "POST", url: "/webhooks/graph", payload: { value } });
    expectProblem(await post([{ clientState: "guess" }]), 401, "unauthorized");
    expectProblem(await post([{ clientState: graphClientState(randomBytes(32), id) }]), 401, "unauthorized");
    expectProblem(
      await post([{ clientState: graphClientState(GRAPH_SECRET, id) }, { clientState: "forged" }]),
      401,
      "unauthorized",
    );
    expectProblem(await post([{ nothing: true }]), 401, "unauthorized");
    expectProblem(await post([]), 401, "unauthorized");
    expect(await pushedAt(id)).toBeNull();
    expect(await pushedAt(other.id)).toBeNull();
  });

  it("Graph: a valid clientState for a Gmail connection does nothing", async () => {
    const { id } = await connection("gmail");
    const res = await t.app.inject({
      method: "POST",
      url: "/webhooks/graph",
      payload: { value: [{ clientState: graphClientState(GRAPH_SECRET, id) }] },
    });
    expect(res.statusCode).toBe(202);
    expect(await pushedAt(id)).toBeNull();
  });
});
