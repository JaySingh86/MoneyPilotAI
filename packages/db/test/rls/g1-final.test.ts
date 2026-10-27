// G1 final fixes (WP-03). Each test failed before 202610271610_wp03_g1-invite-fixes.sql.
// Connects as mp_api / mp_worker only.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createHousehold, inviteMember } from "../../src/seed/flows";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectNoRowsAffected, expectReason, openDbs } from "./helpers";
import { buildHousehold, createUser } from "./world";

let api: ApiDb;
let worker: WorkerDb;

beforeAll(() => {
  ({ api, worker } = openDbs());
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  api.withHouseholdTx({ userId }, fn);

describe("final-1 app_accept_invite assigns the free colour and refuses a full household", () => {
  it("creator leaves; the remaining partner re-invites; the new member gets the free colour (partnerA)", async () => {
    const hh = await buildHousehold(api, "colour");
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update household_members set left_at = now() where user_id = ${hh.creator.id}`),
    );
    const newcomer = await createUser(api, "colour-new");
    const invite = await inviteMember(api, hh.partner, hh.id, newcomer.email);
    expect(await acceptInvite(api, newcomer, invite.token)).toBe(hh.id);

    const roles = await asUser(
      newcomer.id,
      async (tx) =>
        (
          await tx.execute<{ user_id: string; color_role: string }>(
            sql`select user_id, color_role from household_members
                where household_id = ${hh.id} and left_at is null order by color_role`,
          )
        ).rows,
    );
    expect(roles).toEqual([
      { user_id: newcomer.id, color_role: "partnerA" },
      { user_id: hh.partner.id, color_role: "partnerB" },
    ]);
  });

  it("a third person cannot join a household with two active members (invite_household_full)", async () => {
    const hh = await buildHousehold(api, "full");
    const third = await createUser(api, "full-third");
    const invite = await inviteMember(api, hh.creator, hh.id, third.email);
    await expectReason(() => acceptInvite(api, third, invite.token), "invite_household_full");
    expect(await asUser(third.id, (tx) => count(tx, sql`select 1 from household_members`))).toBe(0);
    // The invite stays open (nothing half-applied).
    expect(
      await asUser(hh.creator.id, (tx) =>
        count(tx, sql`select 1 from invites where id = ${invite.id} and accepted_at is null`),
      ),
    ).toBe(1);
  });
});

describe("final-2 no app role can un-revoke an invite", () => {
  it("mp_worker cannot set revoked_at back to null, but can still revoke", async () => {
    const hh = await buildHousehold(api, "wunrevoke");
    const invite = await inviteMember(api, hh.creator, hh.id, `w-${randomUUID()}@example.test`);
    const revoked = await worker.withJobTx(hh.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${invite.id}`),
    );
    expect(revoked.rowCount).toBe(1);
    await expectNoRowsAffected(() =>
      worker.withJobTx(hh.id, (tx) =>
        tx.execute(sql`update invites set revoked_at = null where id = ${invite.id}`),
      ),
    );
    expect(
      await asUser(hh.creator.id, (tx) =>
        count(tx, sql`select 1 from invites where id = ${invite.id} and revoked_at is not null`),
      ),
    ).toBe(1);
  });

  it("mp_api members and invitees cannot either", async () => {
    const hh = await buildHousehold(api, "aunrevoke");
    const invitee = await createUser(api, "aunrevoke-invitee");
    const invite = await inviteMember(api, hh.creator, hh.id, invitee.email);
    await asUser(hh.creator.id, (tx) =>
      tx.execute(sql`update invites set revoked_at = now() where id = ${invite.id}`),
    );
    for (const userId of [hh.creator.id, hh.partner.id, invitee.id]) {
      await expectNoRowsAffected(() =>
        asUser(userId, (tx) => tx.execute(sql`update invites set revoked_at = null where id = ${invite.id}`)),
      );
    }
  });
});

describe("final-3 joining a household scheduled for deletion", () => {
  it("app_accept_invite raises invite_household_deleting", async () => {
    const creator = await createUser(api, "deleting-creator");
    const invitee = await createUser(api, "deleting-invitee");
    const id = randomUUID();
    await createHousehold(api, creator, {
      id,
      name: "Deleting",
      timezone: "America/New_York",
      forwardingToken: `deleting-${id}`,
    });
    const invite = await inviteMember(api, creator, id, invitee.email);
    await asUser(creator.id, (tx) =>
      tx.execute(
        sql`update households set deletion_scheduled_for = now() + interval '7 days' where id = ${id}`,
      ),
    );
    await expectReason(() => acceptInvite(api, invitee, invite.token), "invite_household_deleting");
    expect(await asUser(invitee.id, (tx) => count(tx, sql`select 1 from household_members`))).toBe(0);

    // Cancelling the deletion makes the invite usable again.
    await asUser(creator.id, (tx) =>
      tx.execute(sql`update households set deletion_scheduled_for = null where id = ${id}`),
    );
    expect(await acceptInvite(api, invitee, invite.token)).toBe(id);
  });
});
