// G1 security review regressions (WP-03). Each test failed against the pre-hardening schema.
// Connects as mp_api / mp_worker only.
import { randomUUID } from "node:crypto";
import { maskEmail } from "@mp/format";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashInviteToken, inviteMember } from "../../src/seed/flows";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectNoRowsAffected, expectRejected, openDbs } from "./helpers";
import { buildHousehold, createUser, type TestHousehold } from "./world";

let api: ApiDb;
let worker: WorkerDb;
let hh: TestHousehold;

beforeAll(async () => {
  ({ api, worker } = openDbs());
  hh = await buildHousehold(api, "g1");
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  api.withHouseholdTx({ userId }, fn);

describe("G1-1 (HIGH) invites: an invitee cannot un-revoke, self-accept or self-join", () => {
  it("cannot clear revoked_at on a revoked invite addressed to them", async () => {
    const invitee = await createUser(api, "g1-unrevoke");
    const invite = await inviteMember(api, hh.creator, hh.id, invitee.email);
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${invite.id}`),
    );
    await expectNoRowsAffected(() =>
      asUser(invitee.id, (tx) =>
        tx.execute(sql`update invites set revoked_at = null where id = ${invite.id}`),
      ),
    );
    const stillRevoked = await asUser(hh.creator.id, (tx) =>
      count(tx, sql`select 1 from invites where id = ${invite.id} and revoked_at is not null`),
    );
    expect(stillRevoked).toBe(1);
  });

  it("cannot set accepted_at directly", async () => {
    const invitee = await createUser(api, "g1-selfaccept");
    const invite = await inviteMember(api, hh.creator, hh.id, invitee.email);
    await expectNoRowsAffected(() =>
      asUser(invitee.id, (tx) =>
        tx.execute(sql`update invites set accepted_at = now() where id = ${invite.id}`),
      ),
    );
  });

  it("cannot insert its own membership directly, even holding an open invite", async () => {
    const invitee = await createUser(api, "g1-selfjoin");
    await inviteMember(api, hh.creator, hh.id, invitee.email);
    await expectDenied(() =>
      asUser(invitee.id, (tx) =>
        tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
          values (${hh.id}, ${invitee.id}, 'partnerB', false)`),
      ),
    );
  });

  it("can decline an open invite addressed to them, but not re-open it", async () => {
    const invitee = await createUser(api, "g1-decline");
    const invite = await inviteMember(api, hh.creator, hh.id, invitee.email);
    const res = await asUser(invitee.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${invite.id}`),
    );
    expect(res.rowCount).toBe(1);
    await expectNoRowsAffected(() =>
      asUser(invitee.id, (tx) =>
        tx.execute(sql`update invites set revoked_at = null where id = ${invite.id}`),
      ),
    );
  });

  it("members can revoke but not un-revoke", async () => {
    const invite = await inviteMember(api, hh.creator, hh.id, `g1-member-${randomUUID()}@example.test`);
    const res = await asUser(hh.partner.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${invite.id}`),
    );
    expect(res.rowCount).toBe(1);
    await expectNoRowsAffected(() =>
      asUser(hh.creator.id, (tx) =>
        tx.execute(sql`update invites set revoked_at = null where id = ${invite.id}`),
      ),
    );
  });
});

describe("G1-1 app_accept_invite(token_hash)", () => {
  const accept = (userId: string, token: string) =>
    asUser(userId, async (tx) => {
      const res = await tx.execute<{ household_id: string }>(
        sql`select app_accept_invite(${hashInviteToken(token)}) as household_id`,
      );
      return res.rows[0]?.household_id;
    });

  it("joins the household as partnerB, marks the invite accepted and writes an audit event", async () => {
    const solo = await buildHousehold(api, "g1-accept");
    // End the partner's membership so partnerB is free for a new invitee.
    await asUser(solo.partner.id, (tx) =>
      tx.execute(sql`update household_members set left_at = now() where user_id = ${solo.partner.id}`),
    );
    const invitee = await createUser(api, "g1-acceptor");
    const invite = await inviteMember(api, solo.creator, solo.id, invitee.email.toUpperCase());
    expect(await accept(invitee.id, invite.token)).toBe(solo.id);
    await asUser(invitee.id, async (tx) => {
      expect(
        await count(
          tx,
          sql`select 1 from household_members where household_id = ${solo.id} and user_id = ${invitee.id}
            and color_role = 'partnerB' and not is_creator and left_at is null`,
        ),
      ).toBe(1);
      expect(
        await count(tx, sql`select 1 from invites where id = ${invite.id} and accepted_at is not null`),
      ).toBe(1);
      expect(
        await count(
          tx,
          sql`select 1 from audit_events where household_id = ${solo.id} and action = 'invite.accepted'
            and actor_user_id = ${invitee.id} and entity_id = ${invite.id}`,
        ),
      ).toBe(1);
    });
    // Replay is refused.
    await expectDenied(() => accept(invitee.id, invite.token));
  });

  it("refuses a mismatched email, a revoked, an expired or an unknown token", async () => {
    const invitee = await createUser(api, "g1-refuse");
    const someoneElse = await createUser(api, "g1-other");
    const mismatched = await inviteMember(api, hh.creator, hh.id, someoneElse.email);
    await expectDenied(() => accept(invitee.id, mismatched.token));

    const revoked = await inviteMember(api, hh.creator, hh.id, invitee.email);
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${revoked.id}`),
    );
    await expectDenied(() => accept(invitee.id, revoked.token));

    const expired = await inviteMember(api, hh.creator, hh.id, invitee.email, -1);
    await expectDenied(() => accept(invitee.id, expired.token));

    await expectDenied(() => accept(invitee.id, "not-a-real-token"));
    expect(await asUser(invitee.id, (tx) => count(tx, sql`select 1 from household_members`))).toBe(0);
  });

  it("refuses an anonymous caller and is not executable by mp_worker", async () => {
    const invite = await inviteMember(api, hh.creator, hh.id, `g1-anon-${randomUUID()}@example.test`);
    await expectDenied(() =>
      api.withHouseholdTx({ userId: null }, (tx) =>
        tx.execute(sql`select app_accept_invite(${hashInviteToken(invite.token)})`),
      ),
    );
    await expectDenied(() =>
      worker.withJobTx(hh.id, (tx) =>
        tx.execute(sql`select app_accept_invite(${hashInviteToken(invite.token)})`),
      ),
    );
  });
});

describe("G1-6 app_invite_lookup(token_hash)", () => {
  const lookup = (userId: string | null, token: string) =>
    api.withHouseholdTx({ userId }, async (tx) => {
      const res = await tx.execute<{ status: string; masked_email: string }>(
        sql`select status, masked_email from app_invite_lookup(${hashInviteToken(token)})`,
      );
      return res.rows;
    });

  it("returns only a status and the masked invited email", async () => {
    const invitee = await createUser(api, "g1lookup");
    const stranger = await createUser(api, "g1-lookup-stranger");
    const invite = await inviteMember(api, hh.creator, hh.id, `samrivera-${randomUUID()}@gmail.com`);
    const own = await inviteMember(api, hh.creator, hh.id, invitee.email);
    expect(await lookup(stranger.id, invite.token)).toEqual([
      { status: "mismatch", masked_email: "sam•••@gmail.com" },
    ]);
    expect((await lookup(invitee.id, own.token))[0]?.status).toBe("valid");
    expect(await lookup(invitee.id, "unknown")).toEqual([]);

    const expired = await inviteMember(api, hh.creator, hh.id, invitee.email, -1);
    expect((await lookup(invitee.id, expired.token))[0]?.status).toBe("expired");
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${own.id}`),
    );
    expect((await lookup(invitee.id, own.token))[0]?.status).toBe("revoked");
  });

  it("reports accepted invites", async () => {
    expect((await lookup(hh.partner.id, hh.partnerInviteToken))[0]?.status).toBe("accepted");
  });

  it("is not executable by mp_worker", async () => {
    await expectDenied(() =>
      worker.withJobTx(hh.id, (tx) =>
        tx.execute(sql`select * from app_invite_lookup(${hashInviteToken("x")})`),
      ),
    );
  });

  it.each([
    "samrivera@gmail.com",
    "jordan.rivera@outlook.com",
    "samantha@gmail.com",
    "sami@x.com",
    "sam@x.com",
    "jo@x.com",
    "x@x.com",
    '"a@b"@example.com',
    "éloïse@example.fr",
  ])("masks %s exactly like @mp/format maskEmail", async (email) => {
    const masked = await asUser(hh.creator.id, async (tx) => {
      const res = await tx.execute<{ m: string }>(sql`select app_mask_email(${email}) as m`);
      return res.rows[0]?.m;
    });
    expect(masked).toBe(maskEmail(email));
  });
});

describe("G1-2 (MEDIUM) users: email, MFA flag and deletion change only through auth sync", () => {
  it.each([
    ["email", sql`email = 'hijack@example.test'`],
    ["mfa_enabled", sql`mfa_enabled = true`],
    ["deleted_at", sql`deleted_at = null`],
  ])("mp_api cannot update %s on its own row", async (_name, assignment) => {
    await expectDenied(() =>
      asUser(hh.creator.id, (tx) =>
        tx.execute(sql`update users set ${assignment} where id = ${hh.creator.id}`),
      ),
    );
  });

  it("mp_api can still update its own name and timezone", async () => {
    const res = await asUser(hh.creator.id, (tx) =>
      tx.execute(
        sql`update users set first_name = 'Renamed', timezone = 'America/Chicago' where id = ${hh.creator.id}`,
      ),
    );
    expect(res.rowCount).toBe(1);
  });

  it("mp_worker syncs email and MFA from the auth provider, and can never undelete", async () => {
    const user = await createUser(api, "g1-sync");
    const sync = (email: string, mfa: boolean, deleted: boolean) =>
      worker.withJobTx(hh.id, async (tx) => {
        const res = await tx.execute<{ ok: boolean }>(
          sql`select app_sync_auth_user(${user.authSubject}, ${email}, ${mfa}, ${deleted}) as ok`,
        );
        return res.rows[0]?.ok;
      });
    expect(await sync(`synced-${user.id}@example.test`, true, false)).toBe(true);
    const read = () =>
      api.withHouseholdTx({ userId: null, authSubject: user.authSubject }, async (tx) => {
        const res = await tx.execute<{ email: string; mfa_enabled: boolean; deleted: boolean }>(
          sql`select email, mfa_enabled, deleted_at is not null as deleted from users`,
        );
        return res.rows[0];
      });
    expect(await read()).toEqual({
      email: `synced-${user.id}@example.test`,
      mfa_enabled: true,
      deleted: false,
    });
    await sync(`synced-${user.id}@example.test`, true, true);
    await sync(`synced-${user.id}@example.test`, true, false);
    expect((await read())?.deleted).toBe(true);
  });

  it("returns false for an unknown subject, and mp_api cannot execute it", async () => {
    expect(
      await worker.withJobTx(hh.id, async (tx) => {
        const res = await tx.execute<{ ok: boolean }>(
          sql`select app_sync_auth_user('test|nobody', 'n@example.test', false, false) as ok`,
        );
        return res.rows[0]?.ok;
      }),
    ).toBe(false);
    await expectDenied(() =>
      asUser(hh.creator.id, (tx) =>
        tx.execute(sql`select app_sync_auth_user(${hh.creator.authSubject}, 'h@example.test', true, false)`),
      ),
    );
  });
});

describe("G1-4 (LOW) column-level hardening", () => {
  it("bootstrap cannot choose the users id or the MFA flag", async () => {
    const subject = `test|g1-id|${randomUUID()}`;
    await expectDenied(() =>
      api.withHouseholdTx({ userId: null, authSubject: subject }, (tx) =>
        tx.execute(sql`insert into users (id, auth_subject, email, first_name)
          values (${randomUUID()}, ${subject}, ${`${randomUUID()}@example.test`}, 'Id')`),
      ),
    );
    await expectDenied(() =>
      api.withHouseholdTx({ userId: null, authSubject: subject }, (tx) =>
        tx.execute(sql`insert into users (auth_subject, email, first_name, mfa_enabled)
          values (${subject}, ${`${randomUUID()}@example.test`}, 'Mfa', true)`),
      ),
    );
  });

  it("forwarding_token is not writable by mp_api", async () => {
    await expectDenied(() =>
      asUser(hh.creator.id, (tx) =>
        tx.execute(sql`update households set forwarding_token = 'stolen' where id = ${hh.id}`),
      ),
    );
  });

  it("deletion can be scheduled only ≥ 7 days out, and cancelled", async () => {
    const own = await buildHousehold(api, "g1-del");
    await expectRejected(
      () =>
        asUser(own.creator.id, (tx) =>
          tx.execute(
            sql`update households set deletion_scheduled_for = now() + interval '1 day' where id = ${own.id}`,
          ),
        ),
      "23514",
    );
    await asUser(own.creator.id, (tx) =>
      tx.execute(
        sql`update households set deletion_scheduled_for = now() + interval '7 days' where id = ${own.id}`,
      ),
    );
    // Unrelated edits still work while a deletion is scheduled.
    await asUser(own.partner.id, (tx) =>
      tx.execute(sql`update households set name = 'Still here' where id = ${own.id}`),
    );
    const cancelled = await asUser(own.partner.id, (tx) =>
      tx.execute(sql`update households set deletion_scheduled_for = null where id = ${own.id}`),
    );
    expect(cancelled.rowCount).toBe(1);
  });

  it("the idempotency purge job cannot read stored responses", async () => {
    await expectDenied(() =>
      worker.withJobTx(hh.id, (tx) => tx.execute(sql`select response from idempotency_keys`)),
    );
    await worker.withJobTx(hh.id, (tx) =>
      tx.execute(sql`select user_id, key, created_at from idempotency_keys`),
    );
  });

  it("app roles cannot run the audit purge except mp_worker", async () => {
    await expectDenied(() =>
      asUser(hh.creator.id, (tx) => tx.execute(sql`select * from app_purge_audit_events()`)),
    );
  });
});
