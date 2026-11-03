// WP-13 table rules beyond plain isolation (the generic cross-household cases are in cases.ts): goal write
// grants, append-only goal events, the proposal decision rules (a proposer never decides their own proposal),
// tenant-safe foreign keys on tasks and goal events, and the worker's narrow rights.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asCreator = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asPartner = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.partner.id, householdId: world.a.id }, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

async function newProposal(): Promise<string> {
  return asCreator(async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`insert into proposals
        (household_id, kind, payload, proposed_by, expires_at)
      values (${world.a.id}, 'goal_change', ${JSON.stringify({ type: "goal_delete", goalId: randomUUID() })}::jsonb, ${world.a.creator.id},
        now() + interval '7 days') returning id`);
    return res.rows[0]?.id ?? "";
  });
}

describe("goals: write grants arrive with the proposal gate (Q-050)", () => {
  it("a member adds a goal for their own household, attributed to themselves", async () => {
    await asCreator((tx) =>
      tx.execute(sql`insert into goals (household_id, name, type, target_cents, created_by)
        values (${world.a.id}, 'Vacation', 'savings', 100000, ${world.a.creator.id})`),
    );
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into goals (household_id, name, type, target_cents, created_by)
          values (${world.a.id}, 'Forged', 'savings', 100000, ${world.a.partner.id})`),
      ),
    );
  });

  it("only the granted columns change, and rows are never hard deleted", async () => {
    const id = world.a.items.goalId;
    await asCreator((tx) =>
      tx.execute(sql`update goals set monthly_cents = 5000, saved_cents = 100 where id = ${id}`),
    );
    for (const column of ["household_id", "is_emergency_fund", "created_by", "type", "version"]) {
      await expectDenied(() =>
        asCreator((tx) => tx.execute(sql.raw(`update goals set ${column} = ${column} where id = '${id}'`))),
      );
    }
    await expectDenied(() => asCreator((tx) => tx.execute(sql`delete from goals where id = ${id}`)));
  });

  it("a goal change bumps the version by exactly one", async () => {
    const id = world.a.items.goalId;
    const before = await asCreator((tx) =>
      tx.execute<{ version: number }>(sql`select version from goals where id = ${id}`),
    );
    await asCreator((tx) => tx.execute(sql`update goals set name = 'Emergency fund' where id = ${id}`));
    const after = await asCreator((tx) =>
      tx.execute<{ version: number }>(sql`select version from goals where id = ${id}`),
    );
    expect(Number(after.rows[0]?.version)).toBe(Number(before.rows[0]?.version) + 1);
  });
});

describe("goal_events: append-only and tenant-safe", () => {
  it("a deposit can't be negative, an adjustment can, and nothing can be zero", async () => {
    const insert = (kind: string, cents: number) =>
      asCreator((tx) =>
        tx.execute(sql`insert into goal_events (household_id, goal_id, kind, amount_cents, occurred_on, recorded_by)
          values (${world.a.id}, ${world.a.items.goalId}, ${kind}, ${cents}, '2026-11-01', ${world.a.creator.id})`),
      );
    await expectRejected(() => insert("deposit", -100), CHECK_VIOLATION);
    await expectRejected(() => insert("adjustment", 0), CHECK_VIOLATION);
    await insert("adjustment", -100);
  });

  it("events are attributed to the caller and can't name another household's goal", async () => {
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into goal_events (household_id, goal_id, kind, amount_cents, occurred_on, recorded_by)
          values (${world.a.id}, ${world.a.items.goalId}, 'deposit', 100, '2026-11-01', ${world.a.partner.id})`),
      ),
    );
    await expectRejected(
      () =>
        asCreator((tx) =>
          tx.execute(sql`insert into goal_events (household_id, goal_id, kind, amount_cents, occurred_on, recorded_by)
            values (${world.a.id}, ${world.b.items.goalId}, 'deposit', 100, '2026-11-01', ${world.a.creator.id})`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("neither app role can update or delete an event", async () => {
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`update goal_events set amount_cents = 1 where household_id = ${world.a.id}`),
      ),
    );
    await expectDenied(() =>
      asCreator((tx) => tx.execute(sql`delete from goal_events where household_id = ${world.a.id}`)),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`update goal_events set amount_cents = 1 where household_id = ${world.a.id}`),
      ),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`delete from goal_events where household_id = ${world.a.id}`),
      ),
    );
  });
});

describe("proposals: the proposer never decides their own proposal", () => {
  it("the other member can approve; the proposer can't (policy and CHECK)", async () => {
    const id = await newProposal();
    // The proposer deciding as themselves is refused outright.
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(
          sql`update proposals set status = 'applied', decided_by = ${world.a.creator.id} where id = ${id}`,
        ),
      ),
    );
    // Recording someone else as the decider is refused too.
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(
          sql`update proposals set status = 'applied', decided_by = ${world.a.partner.id} where id = ${id}`,
        ),
      ),
    );
    const res = await asPartner((tx) =>
      tx.execute(sql`update proposals set status = 'applied', decided_by = ${world.a.partner.id}, decided_at = now()
        where id = ${id}`),
    );
    expect(res.rowCount).toBe(1);
  });

  it("a decided proposal is final; a payload can't be edited; the proposer can't be forged", async () => {
    const id = await newProposal();
    await asPartner((tx) =>
      tx.execute(sql`update proposals set status = 'rejected', decided_by = ${world.a.partner.id}, decided_at = now()
        where id = ${id}`),
    );
    const again = await asPartner((tx) =>
      tx.execute(
        sql`update proposals set status = 'applied', decided_by = ${world.a.partner.id} where id = ${id}`,
      ),
    );
    expect(again.rowCount).toBe(0);
    const open = await newProposal();
    for (const column of ["payload", "proposed_by", "expires_at", "household_id", "kind"]) {
      await expectDenied(() =>
        asPartner((tx) =>
          tx.execute(sql.raw(`update proposals set ${column} = ${column} where id = '${open}'`)),
        ),
      );
    }
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into proposals (household_id, kind, payload, proposed_by, expires_at)
          values (${world.a.id}, 'goal_change', '{}'::jsonb, ${world.a.partner.id}, now() + interval '7 days')`),
      ),
    );
    await expectDenied(() => asCreator((tx) => tx.execute(sql`delete from proposals where id = ${open}`)));
  });

  it("the worker expires pending proposals but can't decide, edit or create them", async () => {
    const id = await newProposal();
    const expired = await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`update proposals set status = 'expired' where id = ${id}`),
    );
    expect(expired.rowCount).toBe(1);
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`update proposals set decided_by = ${world.a.partner.id} where id = ${id}`),
      ),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`insert into proposals (household_id, kind, payload, proposed_by, expires_at)
          values (${world.a.id}, 'goal_change', '{}'::jsonb, ${world.a.creator.id}, now() + interval '7 days')`),
      ),
    );
  });

  it("a signed-in stranger can't propose in someone else's household", async () => {
    await expectDenied(() =>
      api.withHouseholdTx({ userId: world.stranger.id, householdId: world.a.id }, (tx) =>
        tx.execute(sql`insert into proposals (household_id, kind, payload, proposed_by, expires_at)
          values (${world.a.id}, 'goal_change', '{}'::jsonb, ${world.stranger.id}, now() + interval '7 days')`),
      ),
    );
  });
});

describe("tasks: tenant-safe references and consistent completion", () => {
  const insertTask = (
    overrides: { itemId?: string | null; ownerType?: string; ownerUserId?: string | null } = {},
  ) =>
    asCreator((tx) =>
      tx.execute(sql`insert into tasks (household_id, title, owner_type, owner_user_id, linked_item_id, source, created_by)
        values (${world.a.id}, 'Probe', ${overrides.ownerType ?? "both"}::owner_type, ${overrides.ownerUserId ?? null},
          ${overrides.itemId ?? null}, 'user', ${world.a.creator.id})`),
    );

  it("a task can't link another household's item or be owned by a non-member", async () => {
    await insertTask({ itemId: world.a.items.itemId });
    await expectRejected(() => insertTask({ itemId: world.b.items.itemId }), FOREIGN_KEY_VIOLATION);
    await expectRejected(
      () => insertTask({ ownerType: "member", ownerUserId: world.b.creator.id }),
      FOREIGN_KEY_VIOLATION,
    );
    await expectRejected(() => insertTask({ ownerType: "member", ownerUserId: null }), CHECK_VIOLATION);
    await insertTask({ ownerType: "member", ownerUserId: world.a.partner.id });
  });

  it("completion carries a reason, and an open task can't be created already completed through the API", async () => {
    await expectRejected(
      () =>
        asCreator((tx) =>
          tx.execute(sql`update tasks set completed_at = now() where household_id = ${world.a.id}
            and id = ${world.a.items.taskId}`),
        ),
      CHECK_VIOLATION,
    );
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into tasks (household_id, title, owner_type, source, created_by, completed_at, completed_reason)
          values (${world.a.id}, 'Done already', 'both', 'user', ${world.a.creator.id}, now(), 'manual')`),
      ),
    );
    await asCreator((tx) =>
      tx.execute(sql`update tasks set completed_at = now(), completed_by = ${world.a.creator.id},
        completed_reason = 'manual' where id = ${world.a.items.taskId}`),
    );
  });

  it("engine tasks are deduplicated per household by key", async () => {
    const key = `flag:${randomUUID()}`;
    const insert = (householdId: string) =>
      worker.withJobTx(householdId, (tx) =>
        tx.execute(sql`insert into tasks (household_id, title, owner_type, source, dedupe_key)
          values (${householdId}, 'Review', 'both', 'engine', ${key})`),
      );
    await insert(world.a.id);
    await expectRejected(() => insert(world.a.id), UNIQUE_VIOLATION);
    await insert(world.b.id); // the same key in another household is fine
  });

  it("no one hard deletes a task, and a version bump follows every update", async () => {
    await expectDenied(() =>
      asCreator((tx) => tx.execute(sql`delete from tasks where id = ${world.a.items.taskId}`)),
    );
    const before = await asCreator((tx) =>
      tx.execute<{ version: number }>(sql`select version from tasks where id = ${world.a.items.taskId}`),
    );
    await asCreator((tx) =>
      tx.execute(sql`update tasks set title = 'Review rent!' where id = ${world.a.items.taskId}`),
    );
    const after = await asCreator((tx) =>
      tx.execute<{ version: number }>(sql`select version from tasks where id = ${world.a.items.taskId}`),
    );
    expect(Number(after.rows[0]?.version)).toBe(Number(before.rows[0]?.version) + 1);
    expect(
      await asCreator((tx) => count(tx, sql`select 1 from tasks where household_id = ${world.a.id}`)),
    ).toBeGreaterThan(0);
  });
});
