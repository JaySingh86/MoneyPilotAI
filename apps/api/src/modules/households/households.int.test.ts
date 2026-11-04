// Households, invites and leave over HTTP with a real database (RLS enforced as mp_api).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";
import { forwardingToken } from "./service";

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

interface HouseholdBody {
  id: string;
  version: number;
  name: string;
  cushionCents: number;
  forwardingToken: string;
}

async function createHousehold(user: TestUser, name = "Rivera"): Promise<HouseholdBody> {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...user.headers, ...key() },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as HouseholdBody;
}

const invite = (owner: TestUser, hid: string, email: string) =>
  api.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/invites`,
    headers: { ...owner.headers, ...key() },
    payload: { email },
  });

const accept = (user: TestUser, token: string) =>
  api.app.inject({ method: "POST", url: "/v1/invites/accept", headers: user.headers, payload: { token } });

async function pairedHousehold(): Promise<{ a: TestUser; b: TestUser; hid: string }> {
  const a = await api.signUp("pair-a");
  const b = await api.signUp("pair-b");
  const h = await createHousehold(a);
  expect((await invite(a, h.id, b.email)).statusCode).toBe(201);
  const sent = api.sent.at(-1);
  expect((await accept(b, sent?.token ?? "")).statusCode).toBe(200);
  return { a, b, hid: h.id };
}

describe("forwarding token", () => {
  it("is a slug of the name plus 3 base32 characters", () => {
    expect(forwardingToken("The Rivera Family!", Buffer.from([0, 1, 255]))).toBe("the-rivera-family-ab7");
    expect(forwardingToken("Ünï Çode", Buffer.from([2, 3, 4]))).toMatch(/^uni-code-[a-z2-7]{3}$/);
    expect(forwardingToken("!!!", Buffer.from([0, 0, 0]))).toBe("household-aaa");
  });
});

describe("create, read, patch", () => {
  it("creates a household with the creator as partnerA and writes an audit event", async () => {
    const user = await api.signUp("creator");
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/households",
      headers: { ...user.headers, ...key() },
      payload: { name: "Rivera", cushionCents: 50000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as HouseholdBody & { timezone: string };
    expect(body).toMatchObject({
      name: "Rivera",
      cushionCents: 50000,
      version: 1,
      timezone: "America/New_York",
    });
    expect(body.forwardingToken).toMatch(/^rivera-[a-z2-7]{3}$/);
    expect(res.headers.etag).toBe('"1"');
    const me = await api.app.inject({ url: "/v1/me", headers: user.headers });
    expect((me.json() as { memberships: unknown[] }).memberships).toMatchObject([
      { householdId: body.id, colorRole: "partnerA", isCreator: true },
    ]);
    const audit = await api.admin(
      async (c) => (await c.query("select action from audit_events where household_id = $1", [body.id])).rows,
    );
    expect(audit).toEqual([{ action: "household.created" }]);
  });

  it("requires an Idempotency-Key on create, and a replay returns the same household", async () => {
    const user = await api.signUp("idem");
    const noKey = await api.app.inject({
      method: "POST",
      url: "/v1/households",
      headers: user.headers,
      payload: { name: "X" },
    });
    expectProblem(noKey, 400, "validation_failed");
    const headers = { ...user.headers, ...key() };
    const first = await api.app.inject({
      method: "POST",
      url: "/v1/households",
      headers,
      payload: { name: "Once" },
    });
    const second = await api.app.inject({
      method: "POST",
      url: "/v1/households",
      headers,
      payload: { name: "Once" },
    });
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect((second.json() as HouseholdBody).id).toBe((first.json() as HouseholdBody).id);
  });

  it("rejects bad input: empty name, negative cushion, unknown fields, bad zone", async () => {
    const user = await api.signUp("bad");
    for (const payload of [
      { name: "" },
      { name: "x", cushionCents: -1 },
      { name: "x", cushionCents: 1.5 },
      { name: "x", plan: "family_plus" },
      { name: "x", timezone: "Nope/Zone" },
    ]) {
      expectProblem(
        await api.app.inject({
          method: "POST",
          url: "/v1/households",
          headers: { ...user.headers, ...key() },
          payload,
        }),
        400,
        "validation_failed",
      );
    }
  });

  it("a third user cannot read, patch, summarize, invite to or leave it (RLS)", async () => {
    const { hid } = await pairedHousehold();
    const stranger = await api.signUp("stranger");
    const h = { headers: stranger.headers };
    expectProblem(await api.app.inject({ url: `/v1/households/${hid}`, ...h }), 404, "not_found");
    expectProblem(await api.app.inject({ url: `/v1/households/${hid}/summary`, ...h }), 404, "not_found");
    expectProblem(
      await api.app.inject({
        method: "PATCH",
        url: `/v1/households/${hid}`,
        headers: { ...stranger.headers, "if-match": "1" },
        payload: { name: "Mine" },
      }),
      404,
      "not_found",
    );
    expectProblem(await invite(stranger, hid, "x@example.test"), 404, "not_found");
    expectProblem(
      await api.app.inject({ method: "POST", url: `/v1/households/${hid}/leave`, ...h }),
      404,
      "not_found",
    );
  });

  it("an unauthenticated or un-bootstrapped caller gets 401 / 403", async () => {
    const { hid } = await pairedHousehold();
    expectProblem(await api.app.inject({ url: `/v1/households/${hid}` }), 401, "unauthorized");
    const fresh = { authorization: (await api.as(`sub-fresh-${crypto.randomUUID()}`)).authorization };
    expectProblem(await api.app.inject({ url: `/v1/households/${hid}`, headers: fresh }), 403, "forbidden");
  });

  it("PATCH needs If-Match; a stale version is 409 with the current resource; success bumps the version", async () => {
    const user = await api.signUp("patcher");
    const h = await createHousehold(user, "Patch");
    const url = `/v1/households/${h.id}`;
    expectProblem(
      await api.app.inject({ method: "PATCH", url, headers: user.headers, payload: { cushionCents: 70000 } }),
      428,
      "precondition_required",
    );
    const ok = await api.app.inject({
      method: "PATCH",
      url,
      headers: { ...user.headers, "if-match": '"1"' },
      payload: { cushionCents: 70000, name: "Patched" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: 2, cushionCents: 70000, name: "Patched" });
    expect(ok.headers.etag).toBe('"2"');
    const stale = await api.app.inject({
      method: "PATCH",
      url,
      headers: { ...user.headers, "if-match": '"1"' },
      payload: { cushionCents: 1 },
    });
    const problem = expectProblem(stale, 409, "conflict");
    expect(problem.current).toMatchObject({ version: 2, cushionCents: 70000 });
    for (const payload of [
      {},
      { plan: "family_plus" },
      { primaryIncomeItemId: crypto.randomUUID() },
      { cushionCents: -5 },
    ]) {
      expectProblem(
        await api.app.inject({
          method: "PATCH",
          url,
          headers: { ...user.headers, "if-match": '"2"' },
          payload,
        }),
        400,
        "validation_failed",
      );
    }
  });

  it("both partners can patch the same household", async () => {
    const { a, b, hid } = await pairedHousehold();
    const get = await api.app.inject({ url: `/v1/households/${hid}`, headers: b.headers });
    expect(get.statusCode).toBe(200);
    const res = await api.app.inject({
      method: "PATCH",
      url: `/v1/households/${hid}`,
      headers: { ...b.headers, "if-match": String((get.json() as HouseholdBody).version) },
      payload: { name: "Both" },
    });
    expect(res.statusCode).toBe(200);
    expect((await api.app.inject({ url: `/v1/households/${hid}`, headers: a.headers })).json()).toMatchObject(
      { name: "Both" },
    );
  });
});

describe("summary", () => {
  it("lists both members, no emails, stubbed badges, and the open invite", async () => {
    const { a, b, hid } = await pairedHousehold();
    const res = await api.app.inject({ url: `/v1/households/${hid}/summary`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      members: Record<string, unknown>[];
      badges: unknown;
      openInvite: unknown;
      entitlements: unknown;
    };
    expect(body.members.map((m) => m.colorRole)).toEqual(["partnerA", "partnerB"]);
    expect(body.members.map((m) => m.userId).sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(body.members)).not.toContain("@");
    expect(body.badges).toEqual({ reviewQueue: 0, tasksDue: 0, proposalsPending: 0 });
    expect(body.openInvite).toBeNull();
    // WP-25: the summary carries the feature map; on Free every Plus feature is read-only.
    expect(body.entitlements).toMatchObject({
      plan: "free",
      maxAdults: 2,
      features: { goals: { read: true, write: false } },
    });
  });
});

describe("two users join one household by invite", () => {
  it("creator invites, partner accepts, both see the household; the token is single-use", async () => {
    const a = await api.signUp("join-a");
    const b = await api.signUp("join-b");
    const h = await createHousehold(a);
    const res = await invite(a, h.id, b.email.toUpperCase());
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty("token");
    expect(JSON.stringify(res.json())).not.toMatch(/[A-Za-z0-9_-]{43}/);
    const sent = api.sent.at(-1);
    expect(sent).toMatchObject({
      to: b.email.toLowerCase(),
      householdName: "Rivera",
      inviterFirstName: "join-a",
    });
    const stored = await api.admin(
      async (c) =>
        (
          await c.query("select encode(token_hash,'hex') as h from invites where id = $1", [
            (res.json() as { id: string }).id,
          ])
        ).rows[0].h,
    );
    expect(stored).not.toContain(sent?.token ?? "?");

    const summary = await api.app.inject({ url: `/v1/households/${h.id}/summary`, headers: a.headers });
    expect((summary.json() as { openInvite: { email: string } }).openInvite.email).toBe(
      b.email.toLowerCase(),
    );

    expect((await api.app.inject({ url: `/v1/households/${h.id}`, headers: b.headers })).statusCode).toBe(
      404,
    );
    const ok = await accept(b, sent?.token ?? "");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ householdId: h.id });
    expect((await api.app.inject({ url: `/v1/households/${h.id}`, headers: b.headers })).statusCode).toBe(
      200,
    );
    const bSummary = (
      await api.app.inject({ url: `/v1/households/${h.id}/summary`, headers: b.headers })
    ).json() as { members: { colorRole: string }[] };
    expect(bSummary.members).toHaveLength(2);
    expectProblem(await accept(b, sent?.token ?? ""), 409, "conflict");

    const audit = await api.admin(async (c) =>
      (await c.query("select action from audit_events where household_id = $1 order by id", [h.id])).rows.map(
        (r) => r.action,
      ),
    );
    expect(audit).toEqual(["household.created", "invite.created", "invite.accepted"]);
  });

  it("a mismatched email is 403 with the masked address; the invite stays usable", async () => {
    const a = await api.signUp("mm-a");
    const invitee = await api.signUp("mm-invitee");
    const wrong = await api.signUp("mm-wrong");
    const h = await createHousehold(a);
    await invite(a, h.id, invitee.email);
    const token = api.sent.at(-1)?.token ?? "";
    const problem = expectProblem(await accept(wrong, token), 403, "forbidden");
    const local = invitee.email.split("@")[0] ?? "";
    expect(problem.detail).toContain(`${local.slice(0, 3)}•••@example.test`);
    expect(problem.detail).not.toContain(invitee.email);
    expect((await api.app.inject({ url: `/v1/households/${h.id}`, headers: wrong.headers })).statusCode).toBe(
      404,
    );
    expect((await accept(invitee, token)).statusCode).toBe(200);
  });

  it("an unknown token is 404; a malformed one is 400", async () => {
    const user = await api.signUp("unknown");
    expectProblem(await accept(user, "A".repeat(43)), 404, "not_found");
    expectProblem(await accept(user, "short"), 400, "validation_failed");
  });

  it("accepting needs sign-in", async () => {
    expectProblem(
      await api.app.inject({ method: "POST", url: "/v1/invites/accept", payload: { token: "A".repeat(43) } }),
      401,
      "unauthorized",
    );
  });

  it("an expired invite is 409 conflict", async () => {
    const a = await api.signUp("exp-a");
    const b = await api.signUp("exp-b");
    const h = await createHousehold(a);
    const created = (await invite(a, h.id, b.email)).json() as { id: string };
    await api.admin((c) =>
      c.query("update invites set expires_at = now() - interval '1 minute' where id = $1", [created.id]),
    );
    const problem = expectProblem(await accept(b, api.sent.at(-1)?.token ?? ""), 409, "conflict");
    expect(problem.detail).toMatch(/expired/i);
  });

  it("a revoked invite is 409 conflict, and revoking twice is fine", async () => {
    const a = await api.signUp("rev-a");
    const b = await api.signUp("rev-b");
    const h = await createHousehold(a);
    const created = (await invite(a, h.id, b.email)).json() as { id: string };
    const del = () =>
      api.app.inject({
        method: "DELETE",
        url: `/v1/households/${h.id}/invites/${created.id}`,
        headers: a.headers,
      });
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(204);
    const problem = expectProblem(await accept(b, api.sent.at(-1)?.token ?? ""), 409, "conflict");
    expect(problem.detail).toMatch(/cancelled/i);
    expectProblem(
      await api.app.inject({
        method: "DELETE",
        url: `/v1/households/${h.id}/invites/${crypto.randomUUID()}`,
        headers: a.headers,
      }),
      404,
      "not_found",
    );
  });

  it("an accepted invite cannot be revoked", async () => {
    const { a, hid } = await pairedHousehold();
    const id = await api.admin(
      async (c) =>
        (await c.query("select id from invites where household_id = $1", [hid])).rows[0].id as string,
    );
    expectProblem(
      await api.app.inject({
        method: "DELETE",
        url: `/v1/households/${hid}/invites/${id}`,
        headers: a.headers,
      }),
      409,
      "conflict",
    );
  });

  it("another household's member cannot revoke this invite", async () => {
    const a = await api.signUp("rv-a");
    const other = await api.signUp("rv-other");
    const h = await createHousehold(a);
    const otherHousehold = await createHousehold(other, "Other");
    const created = (await invite(a, h.id, "someone@example.test")).json() as { id: string };
    // Right household id of their own, wrong invite: nothing to revoke there.
    expectProblem(
      await api.app.inject({
        method: "DELETE",
        url: `/v1/households/${otherHousehold.id}/invites/${created.id}`,
        headers: other.headers,
      }),
      404,
      "not_found",
    );
    expectProblem(
      await api.app.inject({
        method: "DELETE",
        url: `/v1/households/${h.id}/invites/${created.id}`,
        headers: other.headers,
      }),
      404,
      "not_found",
    );
    expect(
      await api.admin(
        async (c) =>
          (await c.query("select revoked_at from invites where id = $1", [created.id])).rows[0].revoked_at,
      ),
    ).toBeNull();
  });

  it("allows one open invite; an expired one is replaced; a full household takes none", async () => {
    const a = await api.signUp("one-a");
    const h = await createHousehold(a);
    expect((await invite(a, h.id, "p1@example.test")).statusCode).toBe(201);
    expectProblem(await invite(a, h.id, "p2@example.test"), 409, "conflict");
    await api.admin((c) =>
      c.query("update invites set expires_at = now() - interval '1 second' where household_id = $1", [h.id]),
    );
    expect((await invite(a, h.id, "p2@example.test")).statusCode).toBe(201);

    const { a: fullOwner, hid } = await pairedHousehold();
    expectProblem(await invite(fullOwner, hid, "third@example.test"), 409, "conflict");
  });

  it("refuses to invite someone already in the household, and a bad address", async () => {
    const { a, b, hid } = await pairedHousehold();
    expectProblem(await invite(a, hid, b.email), 409, "conflict");
    expectProblem(await invite(a, hid, "not-an-email"), 400, "validation_failed");
  });

  it("concurrent creates yield exactly one open invite", async () => {
    const a = await api.signUp("race-a");
    const h = await createHousehold(a);
    const results = await Promise.all([1, 2, 3, 4].map((n) => invite(a, h.id, `race${n}@example.test`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
  });

  it("when delivery fails the invite is cancelled so the next attempt works", async () => {
    const a = await api.signUp("fail-a");
    const h = await createHousehold(a);
    api.failNextInvite();
    expectProblem(await invite(a, h.id, "x@example.test"), 502, "internal_error");
    expect((await invite(a, h.id, "x@example.test")).statusCode).toBe(201);
  });

  it("a second household's invite cannot be accepted when the household is full", async () => {
    const { a, hid } = await pairedHousehold();
    const c = await api.signUp("late-c");
    // Insert a late open invite as the superuser (the API itself refuses to create one).
    const token = "L".repeat(43);
    await api.admin((cl) =>
      cl.query(
        "insert into invites (household_id, email, token_hash, invited_by, expires_at) values ($1, $2, sha256($3::bytea), $4, now() + interval '1 day')",
        [hid, c.email, Buffer.from(token), a.id],
      ),
    );
    expectProblem(await accept(c, token), 409, "conflict");
  });
});

describe("leave (step-up MFA)", () => {
  const leave = (user: TestUser, hid: string, headers: Record<string, string> = user.headers) =>
    api.app.inject({ method: "POST", url: `/v1/households/${hid}/leave`, headers });

  it("works with MFA and a recent sign-in; the leaver loses access, the partner keeps it", async () => {
    const { a, b, hid } = await pairedHousehold();
    expect((await leave(b, hid)).statusCode).toBe(204);
    expect((await api.app.inject({ url: `/v1/households/${hid}`, headers: b.headers })).statusCode).toBe(404);
    const summary = (
      await api.app.inject({ url: `/v1/households/${hid}/summary`, headers: a.headers })
    ).json() as { members: unknown[] };
    expect(summary.members).toHaveLength(1);
    const actions = await api.admin(
      async (c) =>
        (
          await c.query(
            "select action from audit_events where household_id = $1 and action = 'member.left'",
            [hid],
          )
        ).rows,
    );
    expect(actions).toHaveLength(1);
    // The leaver can be invited back (the colour frees up).
    expect((await invite(a, hid, b.email)).statusCode).toBe(201);
    expect((await accept(b, api.sent.at(-1)?.token ?? "")).statusCode).toBe(200);
  });

  it("missing mfa_verified_at: 403 mfa_required, even with mfa_enabled and a fresh sign-in; nothing changes", async () => {
    const { b, hid } = await pairedHousehold();
    const weak = await api.as(b.subject, {
      claims: { email: b.email, mfa_enabled: true, mfa_verified_at: undefined },
    });
    expectProblem(await leave(b, hid, weak), 403, "mfa_required");
    expect((await api.app.inject({ url: `/v1/households/${hid}`, headers: b.headers })).statusCode).toBe(200);
  });

  it("a string-typed mfa_verified_at: 403 mfa_required", async () => {
    const { b, hid } = await pairedHousehold();
    const weak = await api.as(b.subject, {
      claims: { email: b.email, mfa_verified_at: String(Math.floor(Date.now() / 1000)) },
    });
    expectProblem(await leave(b, hid, weak), 403, "mfa_required");
  });

  it("an mfa_verified_at older than 10 minutes: 403 mfa_required; a fresh one passes", async () => {
    const { b, hid } = await pairedHousehold();
    const now = Math.floor(Date.now() / 1000);
    const old = await api.as(b.subject, { claims: { email: b.email, mfa_verified_at: now - 601 } });
    expectProblem(await leave(b, hid, old), 403, "mfa_required");
    const fresh = await api.as(b.subject, { claims: { email: b.email, mfa_verified_at: now - 590 } });
    expect((await leave(b, hid, fresh)).statusCode).toBe(204);
  });

  it("the step-up check runs before the household is touched (a stranger without MFA gets mfa_required)", async () => {
    const { hid } = await pairedHousehold();
    const stranger = await api.signUp("leave-stranger");
    const weak = await api.as(stranger.subject, {
      claims: { email: stranger.email, mfa_verified_at: undefined },
    });
    expectProblem(await leave(stranger, hid, weak), 403, "mfa_required");
  });

  it("the only member cannot leave: use delete instead", async () => {
    const a = await api.signUp("alone");
    const h = await createHousehold(a);
    const problem = expectProblem(await leave(a, h.id), 409, "conflict");
    expect(problem.detail).toMatch(/delete/i);
  });
});
