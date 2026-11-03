// WP-05 migration: one active household per user (Q-085) and creator transfer on leave.
// Connects as mp_api / mp_worker only.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createHousehold, inviteMember } from "../../src/seed/flows";
import type { ApiDb, WorkerDb } from "../../src/tx";
import { expectRejected, openDbs } from "./helpers";
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

const UNIQUE_VIOLATION = "23505";

const newHousehold = (label: string) => ({
  id: randomUUID(),
  name: `H ${label}`,
  timezone: "America/New_York",
  forwardingToken: `${label}-${randomUUID().slice(0, 8)}`,
});

describe("one active household per user", () => {
  it("a user with an active membership cannot create a second household", async () => {
    const user = await createUser(api, "wp05-one-a");
    await createHousehold(api, user, newHousehold("one-a"));
    await expectRejected(() => createHousehold(api, user, newHousehold("one-b")), UNIQUE_VIOLATION);
  });

  it("nor accept an invite into another household while a member of one", async () => {
    const owner = await createUser(api, "wp05-one-owner");
    const hid = randomUUID();
    await createHousehold(api, owner, { ...newHousehold("one-o"), id: hid });
    const member = await createUser(api, "wp05-one-member");
    await createHousehold(api, member, newHousehold("one-m"));
    const invite = await inviteMember(api, owner, hid, member.email);
    await expectRejected(() => acceptInvite(api, member, invite.token), UNIQUE_VIOLATION);
  });

  it("leaving frees the slot", async () => {
    const user = await createUser(api, "wp05-one-leave");
    const first = newHousehold("one-l1");
    await createHousehold(api, user, first);
    await api.withHouseholdTx({ userId: user.id, householdId: first.id }, (tx) =>
      tx.execute(sql`update household_members set left_at = now() where user_id = ${user.id}`),
    );
    await expect(createHousehold(api, user, newHousehold("one-l2"))).resolves.toBe(true);
  });
});

describe("app_transfer_creator", () => {
  const call = (userId: string, hid: string) =>
    api.withHouseholdTx({ userId, householdId: hid }, async (tx) => {
      const res = await tx.execute<{ id: string | null }>(sql`select app_transfer_creator(${hid}) as id`);
      return res.rows[0]?.id ?? null;
    });
  const creatorOf = (hid: string) =>
    api
      .withHouseholdTx({ userId: null }, async () => null)
      .then(() =>
        worker.withJobTx(hid, async (tx) => {
          const res = await tx.execute<{ user_id: string }>(
            sql`select user_id from household_members where household_id = ${hid} and is_creator and left_at is null`,
          );
          return res.rows.map((r) => r.user_id);
        }),
      );

  it("moves is_creator from the active creator to the other active member", async () => {
    const hh = await buildHousehold(api, "wp05-tc");
    expect(await call(hh.creator.id, hh.id)).toBe(hh.partner.id);
    expect(await creatorOf(hh.id)).toEqual([hh.partner.id]);
  });

  it("does nothing for a non-creator, a stranger, or a creator with no partner", async () => {
    const hh = await buildHousehold(api, "wp05-tc2");
    expect(await call(hh.partner.id, hh.id)).toBeNull();
    const stranger = await createUser(api, "wp05-tc-stranger");
    expect(await call(stranger.id, hh.id)).toBeNull();
    expect(await creatorOf(hh.id)).toEqual([hh.creator.id]);
    const solo = await createUser(api, "wp05-tc-solo");
    const h = newHousehold("tc-solo");
    await createHousehold(api, solo, h);
    expect(await call(solo.id, h.id)).toBeNull();
  });

  it("needs a signed-in user", async () => {
    const hh = await buildHousehold(api, "wp05-tc3");
    await expectRejected(
      () =>
        api.withHouseholdTx({ userId: null, authSubject: "x" }, (tx) =>
          tx.execute(sql`select app_transfer_creator(${hh.id})`),
        ),
      "42501",
    );
  });
});
