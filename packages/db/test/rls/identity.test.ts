// RLS for the identity tables that are tenant-defining but have no household_id column (users,
// households), plus the membership join rules (creator claim, invite acceptance, leaving).
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createHousehold, inviteMember } from "../../src/seed/flows";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectNoRowsAffected, openDbs } from "./helpers";
import { buildHousehold, buildWorld, createUser, type World } from "./world";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  api.withHouseholdTx({ userId }, fn);

describe("users", () => {
  it("a member sees themselves and their partner only", async () => {
    const ids = await asUser(world.a.creator.id, async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from users`)).rows.map((r) => r.id).sort(),
    );
    expect(ids).toEqual([world.a.creator.id, world.a.partner.id].sort());
  });

  it("a stranger sees only their own row", async () => {
    const n = await asUser(world.stranger.id, (tx) => count(tx, sql`select 1 from users`));
    expect(n).toBe(1);
  });

  it("bootstrap sees the own row by auth subject before the user id is known", async () => {
    const n = await api.withHouseholdTx({ userId: null, authSubject: world.b.creator.authSubject }, (tx) =>
      count(tx, sql`select 1 from users`),
    );
    expect(n).toBe(1);
  });

  it("cannot create a users row for another auth subject", async () => {
    await expectDenied(() =>
      api.withHouseholdTx({ userId: null, authSubject: "test|attacker" }, (tx) =>
        tx.execute(
          sql`insert into users (auth_subject, email, first_name) values ('test|victim', 'v@example.test', 'V')`,
        ),
      ),
    );
  });

  it("cannot update or delete another household's users", async () => {
    await expectNoRowsAffected(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`update users set first_name = 'x' where id = ${world.b.creator.id}`),
      ),
    );
    // Not even a partner's row is writable.
    await expectNoRowsAffected(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`update users set first_name = 'x' where id = ${world.a.partner.id}`),
      ),
    );
    await expectDenied(() =>
      asUser(world.a.creator.id, (tx) => tx.execute(sql`delete from users where id = ${world.b.creator.id}`)),
    );
  });

  it("cannot change its own auth_subject", async () => {
    await expectDenied(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`update users set auth_subject = 'test|other' where id = ${world.a.creator.id}`),
      ),
    );
  });

  it("a job sees only the members of its household", async () => {
    const ids = await worker.withJobTx(world.a.id, async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from users`)).rows.map((r) => r.id).sort(),
    );
    expect(ids).toEqual([world.a.creator.id, world.a.partner.id].sort());
  });
});

describe("households", () => {
  it("a member sees only their household; a stranger sees none", async () => {
    const ids = await asUser(world.a.partner.id, async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from households`)).rows.map((r) => r.id),
    );
    expect(ids).toEqual([world.a.id]);
    expect(await asUser(world.stranger.id, (tx) => count(tx, sql`select 1 from households`))).toBe(0);
  });

  it("A cannot update, delete or impersonate a creator of household B", async () => {
    await expectNoRowsAffected(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`update households set name = 'pwned' where id = ${world.b.id}`),
      ),
    );
    await expectDenied(() =>
      asUser(world.a.creator.id, (tx) => tx.execute(sql`delete from households where id = ${world.b.id}`)),
    );
    await expectDenied(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`insert into households (id, name, timezone, forwarding_token, created_by)
          values (${randomUUID()}, 'Fake', 'America/New_York', ${`fake-${randomUUID()}`}, ${world.b.creator.id})`),
      ),
    );
  });

  it("the API cannot change the billing plan (worker-only)", async () => {
    await expectDenied(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`update households set plan = 'family_plus' where id = ${world.a.id}`),
      ),
    );
  });

  it("a job for A sees, updates and deletes only A", async () => {
    await worker.withJobTx(world.a.id, async (tx) => {
      expect(
        (await tx.execute<{ id: string }>(sql`select id from households`)).rows.map((r) => r.id),
      ).toEqual([world.a.id]);
    });
    await expectNoRowsAffected(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`update households set plan = 'family_plus' where id = ${world.b.id}`),
      ),
    );
    await expectNoRowsAffected(() =>
      worker.withJobTx(world.a.id, (tx) => tx.execute(sql`delete from households where id = ${world.b.id}`)),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`insert into households (id, name, timezone, forwarding_token, created_by)
          values (${world.a.id}, 'Dup', 'America/New_York', 'dup', ${world.a.creator.id})`),
      ),
    );
  });

  it("every update bumps version by exactly one, and version is not client-writable", async () => {
    const hh = await buildHousehold(api, "ver");
    const read = () =>
      asUser(
        hh.creator.id,
        async (tx) =>
          (await tx.execute<{ version: number }>(sql`select version from households`)).rows[0]?.version,
      );
    const before = await read();
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update households set name = 'Renamed' where id = ${hh.id}`),
    );
    await asUser(hh.partner.id, (tx) =>
      tx.execute(sql`update households set cushion_cents = 60000 where id = ${hh.id}`),
    );
    expect(await read()).toBe((before ?? 0) + 2);
    await expectDenied(() =>
      asUser(hh.creator.id, (tx) => tx.execute(sql`update households set version = 1 where id = ${hh.id}`)),
    );
  });
});

describe("joining a household (household_members insert policy)", () => {
  it("a stranger cannot claim someone else's household as creator, or join without an invite", async () => {
    for (const isCreator of [true, false]) {
      await expectDenied(() =>
        asUser(world.stranger.id, (tx) =>
          tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
            values (${world.a.id}, ${world.stranger.id}, 'partnerB', ${isCreator})`),
        ),
      );
    }
  });

  it("a member cannot add another user to their household", async () => {
    await expectDenied(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
          values (${world.a.id}, ${world.stranger.id}, 'partnerB', false)`),
      ),
    );
  });

  it("a creator can claim only while the household has no members", async () => {
    const creator = await createUser(api, "claim");
    const id = randomUUID();
    await createHousehold(api, creator, {
      id,
      name: "Claim",
      timezone: "America/Chicago",
      forwardingToken: `claim-${id}`,
    });
    // Leaving and re-claiming as creator is not possible: the household is no longer unclaimed.
    await asUser(creator.id, (tx) =>
      tx.execute(sql`update household_members set left_at = now() where household_id = ${id}`),
    );
    await expectDenied(() =>
      asUser(creator.id, (tx) =>
        tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
          values (${id}, ${creator.id}, 'partnerB', true)`),
      ),
    );
  });

  it("an invite lets its addressee join that household only, while it is open", async () => {
    const hh = await buildHousehold(api, "inv");
    const invitee = await createUser(api, "invitee");

    // Invitee sees the invite addressed to them, and no other invite of that household.
    const invite = await inviteMember(api, hh.creator, hh.id, invitee.email.toUpperCase());
    const visible = await asUser(invitee.id, async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from invites`)).rows.map((r) => r.id),
    );
    expect(visible).toEqual([invite.id]);
    // ...but cannot see the household itself until they join.
    expect(await asUser(invitee.id, (tx) => count(tx, sql`select 1 from households`))).toBe(0);

    // The invite does not open household B.
    await expectDenied(() =>
      asUser(invitee.id, (tx) =>
        tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
          values (${world.b.id}, ${invitee.id}, 'partnerB', false)`),
      ),
    );
    // Revoked: cannot join.
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${invite.id}`),
    );
    await expectDenied(() => acceptInvite(api, invitee, invite.token));
  });

  it("an expired invite cannot be accepted; an open one can", async () => {
    const creator = await createUser(api, "exp");
    const invitee = await createUser(api, "exp-invitee");
    const id = randomUUID();
    await createHousehold(api, creator, {
      id,
      name: "Exp",
      timezone: "America/Denver",
      forwardingToken: `exp-${id}`,
    });
    const expired = await inviteMember(api, creator, id, invitee.email, -1);
    await expectDenied(() => acceptInvite(api, invitee, expired.token));
    const open = await inviteMember(api, creator, id, invitee.email);
    await acceptInvite(api, invitee, open.token);
    expect(await asUser(invitee.id, (tx) => count(tx, sql`select 1 from households where id = ${id}`))).toBe(
      1,
    );
  });

  it("a member who leaves loses access to the household and its rows", async () => {
    const hh = await buildHousehold(api, "leave");
    await asUser(hh.partner.id, (tx) =>
      tx.execute(
        sql`update household_members set left_at = now() where household_id = ${hh.id} and user_id = ${hh.partner.id}`,
      ),
    );
    await asUser(hh.partner.id, async (tx) => {
      expect(await count(tx, sql`select 1 from households`)).toBe(0);
      expect(await count(tx, sql`select 1 from invites where household_id = ${hh.id}`)).toBe(0);
      expect(await count(tx, sql`select 1 from audit_events where household_id = ${hh.id}`)).toBe(0);
      // Only their own (ended) membership row stays visible to them.
      expect(await count(tx, sql`select 1 from household_members where household_id = ${hh.id}`)).toBe(1);
    });
    // And cannot re-activate it.
    await expectNoRowsAffected(() =>
      asUser(hh.partner.id, (tx) =>
        tx.execute(
          sql`update household_members set left_at = null where household_id = ${hh.id} and user_id = ${hh.partner.id}`,
        ),
      ),
    );
  });

  it("a member cannot end their partner's membership", async () => {
    await expectNoRowsAffected(() =>
      asUser(world.a.creator.id, (tx) =>
        tx.execute(sql`update household_members set left_at = now() where user_id = ${world.a.partner.id}`),
      ),
    );
  });
});

describe("idempotency_keys (user-scoped)", () => {
  it("are visible and writable only by their user; jobs see only expired keys", async () => {
    const key = `key-${randomUUID()}`;
    await asUser(world.a.creator.id, (tx) =>
      tx.execute(
        sql`insert into idempotency_keys (key, user_id, request_hash) values (${key}, ${world.a.creator.id}, ${randomBytes(32)})`,
      ),
    );
    expect(
      await asUser(world.a.creator.id, (tx) =>
        count(tx, sql`select 1 from idempotency_keys where key = ${key}`),
      ),
    ).toBe(1);
    // Partner, other household and stranger: nothing.
    for (const other of [world.a.partner.id, world.b.creator.id, world.stranger.id]) {
      expect(await asUser(other, (tx) => count(tx, sql`select 1 from idempotency_keys`))).toBe(0);
      await expectNoRowsAffected(() =>
        asUser(other, (tx) =>
          tx.execute(sql`update idempotency_keys set status_code = 500 where key = ${key}`),
        ),
      );
      await expectNoRowsAffected(() =>
        asUser(other, (tx) => tx.execute(sql`delete from idempotency_keys where key = ${key}`)),
      );
    }
    await expectDenied(() =>
      asUser(world.b.creator.id, (tx) =>
        tx.execute(
          sql`insert into idempotency_keys (key, user_id, request_hash) values ('forged', ${world.a.creator.id}, ${randomBytes(32)})`,
        ),
      ),
    );
    expect(
      await worker.withJobTx(world.a.id, (tx) =>
        count(tx, sql`select 1 from idempotency_keys where key = ${key}`),
      ),
    ).toBe(0);
    await expectNoRowsAffected(() =>
      worker.withJobTx(world.a.id, (tx) => tx.execute(sql`delete from idempotency_keys where key = ${key}`)),
    );
  });
});

describe("webhook_events (no tenant data)", () => {
  it("deduplicate by (provider, event_id); app roles cannot delete them", async () => {
    const eventId = `evt_${randomUUID()}`;
    const insert = () =>
      api.withHouseholdTx({ userId: null }, (tx) =>
        tx.execute(
          sql`insert into webhook_events (provider, event_id) values ('clerk', ${eventId}) on conflict do nothing`,
        ),
      );
    expect((await insert()).rowCount).toBe(1);
    expect((await insert()).rowCount).toBe(0);
    await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(
        sql`update webhook_events set processed_at = now() where provider = 'clerk' and event_id = ${eventId}`,
      ),
    );
    await expectDenied(() =>
      api.withHouseholdTx({ userId: null }, (tx) => tx.execute(sql`delete from webhook_events`)),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) => tx.execute(sql`delete from webhook_events`)),
    );
  });
});
