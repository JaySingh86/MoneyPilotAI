// G1 fix round: one household per user, invite caps and escaping, concurrent accepts, leave side effects.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";
import { DAILY_INVITE_LIMIT } from "./service";

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

async function createHousehold(user: TestUser, name = "Rivera") {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...user.headers, ...key() },
    payload: { name },
  });
  return res;
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

const leave = (user: TestUser, hid: string) =>
  api.app.inject({ method: "POST", url: `/v1/households/${hid}/leave`, headers: user.headers });

async function pair(): Promise<{ a: TestUser; b: TestUser; hid: string }> {
  const a = await api.signUp("fx-a");
  const b = await api.signUp("fx-b");
  const hid = (await createHousehold(a)).json<{ id: string }>().id;
  await invite(a, hid, b.email);
  expect((await accept(b, api.sent.at(-1)?.token ?? "")).statusCode).toBe(200);
  return { a, b, hid };
}

describe("one active household per user (Q-085)", () => {
  it("creating a second household is 409 conflict", async () => {
    const user = await api.signUp("two-create");
    expect((await createHousehold(user)).statusCode).toBe(201);
    const problem = expectProblem(await createHousehold(user, "Second"), 409, "conflict");
    expect(problem.detail).toMatch(/already belong to a household/i);
  });

  it("accepting an invite into another household while in one is 409 conflict", async () => {
    const owner = await api.signUp("two-owner");
    const member = await api.signUp("two-member");
    const hid = (await createHousehold(owner)).json<{ id: string }>().id;
    expect((await createHousehold(member, "Mine")).statusCode).toBe(201);
    await invite(owner, hid, member.email);
    expectProblem(await accept(member, api.sent.at(-1)?.token ?? ""), 409, "conflict");
  });

  it("concurrent creates by one user: exactly one wins", async () => {
    const user = await api.signUp("two-race");
    const results = await Promise.all([createHousehold(user, "A"), createHousehold(user, "B")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it("leaving frees the slot", async () => {
    const user = await api.signUp("two-free");
    const first = (await createHousehold(user)).json<{ id: string }>().id;
    const partner = await api.signUp("two-free-p");
    await invite(user, first, partner.email);
    await accept(partner, api.sent.at(-1)?.token ?? "");
    expect((await leave(user, first)).statusCode).toBe(204);
    expect((await createHousehold(user, "Fresh")).statusCode).toBe(201);
  });
});

describe("invite caps and escaping (M2)", () => {
  it(`the ${DAILY_INVITE_LIMIT + 1}th invite in a day is 429 rate_limited`, async () => {
    const owner = await api.signUp("cap");
    const hid = (await createHousehold(owner)).json<{ id: string }>().id;
    for (let n = 0; n < DAILY_INVITE_LIMIT; n++) {
      const res = await invite(owner, hid, `cap${n}@example.test`);
      expect(res.statusCode).toBe(201);
      const id = res.json<{ id: string }>().id;
      expect(
        (
          await api.app.inject({
            method: "DELETE",
            url: `/v1/households/${hid}/invites/${id}`,
            headers: owner.headers,
          })
        ).statusCode,
      ).toBe(204);
    }
    expectProblem(await invite(owner, hid, "one-too-many@example.test"), 429, "rate_limited");
  });

  it("the sender receives HTML-escaped household and inviter names", async () => {
    const owner = await api.signUp("esc", { firstName: `Eve <img src=x onerror=1>` });
    const hid = (await createHousehold(owner, `A&B "Co" <script>`)).json<{ id: string }>().id;
    await invite(owner, hid, "friend@example.test");
    const sent = api.sent.at(-1);
    expect(sent?.householdName).toBe("A&amp;B &quot;Co&quot; &lt;script&gt;");
    expect(sent?.inviterFirstName).toBe("Eve &lt;img src=x onerror=1&gt;");
  });

  it("the 201 invite body has no token", async () => {
    const owner = await api.signUp("notok");
    const hid = (await createHousehold(owner)).json<{ id: string }>().id;
    const res = await invite(owner, hid, "friend@example.test");
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(["createdAt", "email", "expiresAt", "id"]);
  });
});

describe("concurrent accepts (L1)", () => {
  it("two different accepters of one token: only the invitee joins", async () => {
    const owner = await api.signUp("dbl-o");
    const invitee = await api.signUp("dbl-i");
    const other = await api.signUp("dbl-x");
    const hid = (await createHousehold(owner)).json<{ id: string }>().id;
    await invite(owner, hid, invitee.email);
    const token = api.sent.at(-1)?.token ?? "";
    const results = await Promise.all([accept(invitee, token), accept(other, token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    const count = await api.admin(async (c) =>
      Number(
        (
          await c.query(
            "select count(*) from household_members where household_id = $1 and left_at is null",
            [hid],
          )
        ).rows[0].count,
      ),
    );
    expect(count).toBe(2);
  });

  it("the same accepter twice at once: one 200, one 409, one membership", async () => {
    const owner = await api.signUp("dbl2-o");
    const invitee = await api.signUp("dbl2-i");
    const hid = (await createHousehold(owner)).json<{ id: string }>().id;
    await invite(owner, hid, invitee.email);
    const token = api.sent.at(-1)?.token ?? "";
    const results = await Promise.all([accept(invitee, token), accept(invitee, token)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const count = await api.admin(async (c) =>
      Number(
        (
          await c.query("select count(*) from household_members where household_id = $1 and user_id = $2", [
            hid,
            invitee.id,
          ])
        ).rows[0].count,
      ),
    );
    expect(count).toBe(1);
  });
});

describe("leave side effects (L4)", () => {
  it("revokes the pending invites the leaver created", async () => {
    const { b, hid } = await pair();
    // The API refuses a 3rd invite in a full household, so plant one as the superuser.
    await api.admin((c) =>
      c.query(
        "insert into invites (household_id, email, token_hash, invited_by, expires_at) values ($1, 'late@example.test', sha256('late'::bytea), $2, now() + interval '1 day')",
        [hid, b.id],
      ),
    );
    expect((await leave(b, hid)).statusCode).toBe(204);
    const open = await api.admin(
      async (c) =>
        (
          await c.query(
            "select count(*)::int as n from invites where household_id = $1 and invited_by = $2 and revoked_at is null and accepted_at is null",
            [hid, b.id],
          )
        ).rows[0].n,
    );
    expect(open).toBe(0);
  });

  it("when the creator leaves, the remaining member becomes the creator", async () => {
    const { a, b, hid } = await pair();
    expect((await leave(a, hid)).statusCode).toBe(204);
    const summary = await api.app.inject({ url: `/v1/households/${hid}/summary`, headers: b.headers });
    expect(summary.json<{ members: { userId: string; isCreator: boolean }[] }>().members).toEqual([
      expect.objectContaining({ userId: b.id, isCreator: true }),
    ]);
  });

  it("when the non-creator leaves, the creator stays the creator", async () => {
    const { a, b, hid } = await pair();
    expect((await leave(b, hid)).statusCode).toBe(204);
    const summary = await api.app.inject({ url: `/v1/households/${hid}/summary`, headers: a.headers });
    expect(summary.json<{ members: { userId: string; isCreator: boolean }[] }>().members).toEqual([
      expect.objectContaining({ userId: a.id, isCreator: true }),
    ]);
  });
});
