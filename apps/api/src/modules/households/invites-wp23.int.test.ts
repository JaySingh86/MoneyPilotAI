// WP-23 fix round (Q-177, Q-179): the invitee's first name, "Resend", and `mfaEnabled` on summary members.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendQuotaExceededError } from "@mp/notify";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import type { InviteSender } from "../../auth/runtime";
import { expectProblem } from "../../lib/testing";
import { DAILY_INVITE_LIMIT } from "./service";

let api: TestApi;
let quotaLeft = 100;
const tokens: string[] = [];
const sentNames: (string | undefined)[] = [];
let sends = 0;

beforeAll(async () => {
  const sender: InviteSender = {
    async canSend() {
      return quotaLeft > 0;
    },
    async send(invite) {
      sends += 1;
      if (quotaLeft <= 0) throw new SendQuotaExceededError();
      quotaLeft -= 1;
      sentNames.push(invite.inviteeFirstName);
      tokens.push(invite.token);
    },
  };
  api = await createTestApi({ inviteSender: () => sender });
});
afterAll(async () => {
  await api.close();
});

async function household(user: TestUser): Promise<string> {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...user.headers, ...key() },
    payload: { name: "Rivera" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

const invite = (user: TestUser, hid: string, payload: Record<string, unknown>) =>
  api.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/invites`,
    headers: { ...user.headers, ...key() },
    payload,
  });

const resend = (user: TestUser, hid: string, id: string) =>
  api.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/invites/${id}/resend`,
    headers: { ...user.headers, ...key() },
  });

const accept = (user: TestUser, token: string) =>
  api.app.inject({ method: "POST", url: "/v1/invites/accept", headers: user.headers, payload: { token } });

const tokenHash = (id: string) =>
  api.admin(
    async (c) =>
      (await c.query("select encode(token_hash,'hex') as h from invites where id = $1", [id])).rows[0]
        .h as string,
  );

describe("invite first name (Q-179)", () => {
  it("is optional, trimmed, returned on the invite and on the summary", async () => {
    const a = await api.signUp("fn-a");
    const hid = await household(a);
    const res = await invite(a, hid, { email: "jordan@example.test", firstName: "  Jordan " });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ email: "jordan@example.test", firstName: "Jordan" });
    const summary = await api.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/summary`,
      headers: a.headers,
    });
    expect(summary.json().openInvite).toMatchObject({ firstName: "Jordan" });
  });

  it("is null when not given, and rejected when empty or over 50 characters", async () => {
    const a = await api.signUp("fn-b");
    const hid = await household(a);
    expectProblem(
      await invite(a, hid, { email: "x@example.test", firstName: "J".repeat(51) }),
      400,
      "validation_failed",
    );
    expectProblem(
      await invite(a, hid, { email: "x@example.test", firstName: "   " }),
      400,
      "validation_failed",
    );
    const ok = await invite(a, hid, { email: "x@example.test" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().firstName).toBeNull();
  });
});

describe("resend an invite (Q-179)", () => {
  it("issues a new token on the same open invite; the old link stops working", async () => {
    const a = await api.signUp("rs-a");
    const b = await api.signUp("rs-b");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: b.email, firstName: "Bee" })).json() as { id: string };
    const oldToken = tokens.at(-1) ?? "";
    const oldHash = await tokenHash(created.id);

    const res = await resend(a, hid, created.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: created.id, email: b.email, firstName: "Bee" });
    const newToken = tokens.at(-1) ?? "";
    expect(newToken).not.toBe(oldToken);
    expect(await tokenHash(created.id)).not.toBe(oldHash);
    await api.admin(async (c) =>
      expect(
        (await c.query("select count(*)::int as n from invites where household_id = $1", [hid])).rows[0].n,
      ).toBe(1),
    );

    expectProblem(await accept(b, oldToken), 404, "not_found");
    expect((await accept(b, newToken)).statusCode).toBe(200);
  });

  it("is 409 for an accepted, revoked or expired invite and 404 for an unknown one", async () => {
    const a = await api.signUp("rs-c");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "c@example.test" })).json() as { id: string };
    await api.admin((c) =>
      c.query("update invites set expires_at = now() - interval '1 minute' where id = $1", [created.id]),
    );
    expectProblem(await resend(a, hid, created.id), 409, "conflict");
    expectProblem(await resend(a, hid, crypto.randomUUID()), 404, "not_found");

    const d = await api.signUp("rs-d");
    const hid2 = await household(d);
    const second = (await invite(d, hid2, { email: "d@example.test" })).json() as { id: string };
    await api.admin((c) => c.query("update invites set revoked_at = now() where id = $1", [second.id]));
    expectProblem(await resend(d, hid2, second.id), 409, "conflict");
  });

  it("counts against the per-user send quota, and a refused resend leaves the old link working", async () => {
    const a = await api.signUp("rs-e");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "e@example.test" })).json() as { id: string };
    const before = await tokenHash(created.id);
    quotaLeft = 0;
    try {
      expectProblem(await resend(a, hid, created.id), 429, "rate_limited");
    } finally {
      quotaLeft = 100;
    }
    expect(await tokenHash(created.id)).toBe(before);
  });

  it("another household's member cannot resend it (RLS)", async () => {
    const a = await api.signUp("rs-f");
    const stranger = await api.signUp("rs-g");
    const hid = await household(a);
    const strangerHid = await household(stranger);
    const created = (await invite(a, hid, { email: "f@example.test" })).json() as { id: string };
    const before = await tokenHash(created.id);
    expectProblem(await resend(stranger, hid, created.id), 404, "not_found");
    expectProblem(await resend(stranger, strangerHid, created.id), 404, "not_found");
    expect(await tokenHash(created.id)).toBe(before);
  });
});

describe("resend: limits, lifetime and replay (review fixes)", () => {
  it("refuses before rotating when the send quota is used up (nothing is sent, the token is untouched)", async () => {
    const a = await api.signUp("rl-a");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "rl@example.test" })).json() as { id: string };
    const before = await tokenHash(created.id);
    const sendsBefore = sends;
    quotaLeft = 0;
    try {
      expectProblem(await resend(a, hid, created.id), 429, "rate_limited");
    } finally {
      quotaLeft = 100;
    }
    expect(sends).toBe(sendsBefore);
    expect(await tokenHash(created.id)).toBe(before);
  });

  it("refuses before rotating when the user already created the daily limit of invites", async () => {
    const a = await api.signUp("rl-b");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "rlb@example.test" })).json() as { id: string };
    await api.admin(async (c) => {
      for (let n = 0; n < DAILY_INVITE_LIMIT - 1; n++)
        await c.query(
          `insert into invites (household_id, email, token_hash, invited_by, expires_at, revoked_at)
           values ($1, $2, decode(md5(random()::text) || md5(random()::text), 'hex'), $3, now() + interval '1 day', now())`,
          [hid, `old${n}@example.test`, a.id],
        );
    });
    const before = await tokenHash(created.id);
    const sendsBefore = sends;
    expectProblem(await resend(a, hid, created.id), 429, "rate_limited");
    expect(sends).toBe(sendsBefore);
    expect(await tokenHash(created.id)).toBe(before);
  });

  it("never extends an invite past 30 days from when it was first sent", async () => {
    const a = await api.signUp("cap-a");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "cap@example.test" })).json() as { id: string };
    await api.admin((c) =>
      c.query(
        "update invites set created_at = now() - interval '29 days', expires_at = now() + interval '1 hour' where id = $1",
        [created.id],
      ),
    );
    expect((await resend(a, hid, created.id)).statusCode).toBe(200);
    await api.admin(async (c) => {
      const r = await c.query(
        "select expires_at <= created_at + interval '30 days' as capped, expires_at > now() as open from invites where id = $1",
        [created.id],
      );
      expect(r.rows[0]).toEqual({ capped: true, open: true });
    });
  });

  it("an explicit expiry needs the expected hash and is clamped to 30 days (defence in depth)", async () => {
    const a = await api.signUp("clamp-a");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "clamp@example.test" })).json() as { id: string };
    await api.admin(async (c) => {
      await c.query("begin");
      try {
        await c.query("select set_config('app.user_id', $1, true), set_config('app.household_id', $2, true)", [
          a.id,
          hid,
        ]);
        const cur = await c.query<{ token_hash: Buffer }>("select token_hash from invites where id = $1", [created.id]);
        const far = "2099-01-01T00:00:00Z";
        const noHash = await c.query<{ r: string }>(
          "select app_rotate_invite_token($1, $2, $3, $4, null) as r",
          [hid, created.id, Buffer.from("x".repeat(32)), far],
        );
        expect(noHash.rows[0]?.r).toBe("closed");
        const withHash = await c.query<{ r: string }>(
          "select app_rotate_invite_token($1, $2, $3, $4, $5) as r",
          [hid, created.id, Buffer.from("y".repeat(32)), far, cur.rows[0]?.token_hash],
        );
        expect(withHash.rows[0]?.r).toBe("ok");
        const r = await c.query("select expires_at <= created_at + interval '30 days' as capped from invites where id = $1", [
          created.id,
        ]);
        expect(r.rows[0]).toEqual({ capped: true });
      } finally {
        await c.query("rollback");
      }
    });
  });

  it("a replay with the same Idempotency-Key does not send again", async () => {
    const a = await api.signUp("replay-a");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: "replay@example.test" })).json() as { id: string };
    const send = () =>
      api.app.inject({
        method: "POST",
        url: `/v1/households/${hid}/invites/${created.id}/resend`,
        headers: { ...a.headers, "idempotency-key": "resend-replay-1" },
      });
    const first = await send();
    expect(first.statusCode).toBe(200);
    const sendsAfterFirst = sends;
    const hash = await tokenHash(created.id);
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(sends).toBe(sendsAfterFirst);
    expect(await tokenHash(created.id)).toBe(hash);
  });
});

describe("accept refusals carry a stable reason (review fix)", () => {
  const reasonOf = (res: { json(): unknown }) => (res.json() as { reason?: string }).reason;

  it("expired, revoked, used, wrong_email and in_other_household", async () => {
    const a = await api.signUp("rsn-a");
    const b = await api.signUp("rsn-b");
    const stranger = await api.signUp("rsn-s");
    const hid = await household(a);
    const created = (await invite(a, hid, { email: b.email })).json() as { id: string };
    const token = tokens.at(-1) ?? "";

    const wrong = await accept(stranger, token);
    expect(wrong.statusCode).toBe(403);
    expect(reasonOf(wrong)).toBe("wrong_email");

    const other = await api.signUp("rsn-o");
    await household(other);
    await api.admin((c) => c.query("update invites set email = $2 where id = $1", [created.id, other.email]));
    const inOther = await accept(other, token);
    expect(reasonOf(inOther)).toBe("in_other_household");
    await api.admin((c) => c.query("update invites set email = $2 where id = $1", [created.id, b.email]));

    await api.admin((c) =>
      c.query("update invites set expires_at = now() - interval '1 minute' where id = $1", [created.id]),
    );
    expect(reasonOf(await accept(b, token))).toBe("expired");
    await api.admin((c) =>
      c.query("update invites set expires_at = now() + interval '1 day', revoked_at = now() where id = $1", [
        created.id,
      ]),
    );
    expect(reasonOf(await accept(b, token))).toBe("revoked");
    await api.admin((c) =>
      c.query("update invites set revoked_at = null, accepted_at = now() where id = $1", [created.id]),
    );
    expect(reasonOf(await accept(b, token))).toBe("used");
  });

  it("full", async () => {
    const a = await api.signUp("full-a");
    const b = await api.signUp("full-b");
    const c3 = await api.signUp("full-c");
    const hid = await household(a);
    await invite(a, hid, { email: b.email });
    expect((await accept(b, tokens.at(-1) ?? "")).statusCode).toBe(200);
    // A late open invite for a third person, inserted as the superuser (the API refuses to create one).
    const late = "Q".repeat(43);
    await api.admin((c) =>
      c.query(
        `insert into invites (household_id, email, token_hash, invited_by, expires_at)
         values ($1, $2, sha256($3::bytea), $4, now() + interval '1 day')`,
        [hid, c3.email, Buffer.from(late), a.id],
      ),
    );
    const res = await accept(c3, late);
    expect(res.statusCode).toBe(409);
    expect(reasonOf(res)).toBe("full");
  });
});

describe("invitee first name is HTML-escaped for the sender like the other names (review fix)", () => {
  it("hands the sender an escaped name and returns the stored text unchanged", async () => {
    const a = await api.signUp("esc-a");
    const hid = await household(a);
    const res = await invite(a, hid, { email: "esc@example.test", firstName: `Jo <img src=x onerror=1>` });
    expect(res.statusCode).toBe(201);
    expect(sentNames.at(-1)).toBe("Jo &lt;img src=x onerror=1&gt;");
    expect(res.json().firstName).toBe("Jo <img src=x onerror=1>");
  });
});

describe("mfaEnabled on summary members (Q-177)", () => {
  it("mirrors users.mfa_enabled for each member", async () => {
    const a = await api.signUp("mfa-a");
    const hid = await household(a);
    const read = async () =>
      (
        await api.app.inject({ method: "GET", url: `/v1/households/${hid}/summary`, headers: a.headers })
      ).json().members as { userId: string; mfaEnabled: boolean }[];
    await api.admin((c) => c.query("update users set mfa_enabled = false where id = $1", [a.id]));
    expect((await read())[0]?.mfaEnabled).toBe(false);
    await api.admin((c) => c.query("update users set mfa_enabled = true where id = $1", [a.id]));
    expect((await read())[0]?.mfaEnabled).toBe(true);
  });
});
