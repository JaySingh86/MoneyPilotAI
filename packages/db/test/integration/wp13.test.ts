// WP-13 on a real database: the seeded fixture tasks (3 due this week, 4 later, 3 done, nav badge 3), task
// auto-completion, proposal expiry, and the proposer-never-decides CHECK.
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { tasksDueThisWeek, type TaskInput } from "@mp/engine";
import { expireProposals } from "../../src/proposals/expire";
import { planningUuid, seedPlanning } from "../../src/seed/items";
import { seedFixture, type SeedResult } from "../../src/seed/rivera";
import { planTasksSeed } from "../../src/seed/tasks";
import { autoCompleteTasks } from "../../src/tasks/auto-complete";
import { createApiDb, createWorkerDb, type ApiDb, type Tx, type WorkerDb } from "../../src/tx";
import { FIXTURE_PATH } from "../setup/paths";

const TODAY = "2026-10-27";
let api: ApiDb;
let worker: WorkerDb;
let seeded: SeedResult;
let fixture: unknown;
const fx = (id: string) => planningUuid(seeded.householdId, id);
const asCreator = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: seeded.userIds.creator, householdId: seeded.householdId }, fn);
const asPartner = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: seeded.userIds.partner, householdId: seeded.householdId }, fn);

beforeAll(async () => {
  api = createApiDb({ connectionString: inject("databaseUrl") });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl") });
  // The golden household under its own identity, so this file does not race the other seed tests.
  const raw = (await readFile(FIXTURE_PATH, "utf8"))
    .replaceAll("hh-rivera", "hh-rivera-wp13")
    .replaceAll("m-sam", "m-sam-wp13")
    .replaceAll("m-jordan", "m-jordan-wp13")
    .replaceAll("rivera-7k2", "rivera-wp13")
    .replaceAll("@rivera-household.example", "@wp13.example");
  fixture = JSON.parse(raw);
  seeded = await seedFixture({ api, worker }, fixture);
  await seedPlanning({ api, worker }, seeded, fixture);
}, 120_000);
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("seeded fixture tasks (acceptance)", () => {
  async function taskInputs(): Promise<TaskInput[]> {
    const res = await asCreator((tx) =>
      tx.execute<{
        id: string;
        title: string;
        owner_type: string;
        owner_user_id: string | null;
        due_on: string | null;
        done: boolean;
      }>(
        sql`select id, title, owner_type, owner_user_id, due_on::text as due_on, (completed_at is not null) as done
          from tasks where household_id = ${seeded.householdId} order by id`,
      ),
    );
    return res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      owner: r.owner_type === "member" ? String(r.owner_user_id) : r.owner_type,
      dueOn: r.due_on,
      completed: r.done,
    }));
  }

  it("maps all 10 fixture tasks and rejects an unknown one", () => {
    expect(planTasksSeed(fixture)).toHaveLength(10);
    const bad = structuredClone(fixture) as { tasks: { id: string }[] };
    bad.tasks[0]!.id = "t99";
    expect(() => planTasksSeed(bad)).toThrow(/t99/);
  });

  it("the engine groups them 3 due this week, 4 later, 3 done, with a nav badge of 3", async () => {
    const groups = tasksDueThisWeek(await taskInputs(), TODAY);
    expect(groups.dueThisWeek).toHaveLength(3);
    expect(groups.later).toHaveLength(4);
    expect(groups.done).toHaveLength(3);
    expect(groups.navBadge).toBe(3);
    expect(groups.dueThisWeek.map((t) => t.title)).toEqual([
      "Review 2 flagged subscriptions",
      "Enter the actual electricity amount",
      "Compare car insurance renewal quote",
    ]);
  });

  it("keeps owners, hints and links from the fixture, and is idempotent", async () => {
    const before = await taskInputs();
    expect((await seedPlanning({ api, worker }, seeded, fixture)).created).toBe(false);
    expect(await taskInputs()).toHaveLength(before.length);
    const power = await asCreator((tx) =>
      tx.execute<{
        owner_user_id: string;
        due_hint: string;
        linked_item_id: string;
        source: string;
        rule: unknown;
      }>(
        sql`select owner_user_id, due_hint, linked_item_id, source, auto_complete_rule as rule from tasks
          where id = ${fx("t2")}`,
      ),
    );
    expect(power.rows[0]).toMatchObject({
      owner_user_id: seeded.userIds.creator,
      due_hint: "When the bill arrives, about Nov 1",
      linked_item_id: fx("b-power"),
      source: "engine",
      rule: { type: "actual_amount_received", itemId: fx("b-power") },
    });
  });
});

describe("autoCompleteTasks", () => {
  it("completes a task when its event arrives, records why, and does it once", async () => {
    const done = await asCreator((tx) =>
      autoCompleteTasks(
        tx,
        seeded.householdId,
        { type: "actual_amount_received", itemId: fx("b-power") },
        seeded.userIds.creator,
      ),
    );
    expect(done).toEqual([{ taskId: fx("t2"), title: "Enter the actual electricity amount" }]);
    const row = await asCreator((tx) =>
      tx.execute<{ completed: boolean; completed_by: string | null; completed_reason: string }>(
        sql`select completed_at is not null as completed, completed_by, completed_reason from tasks where id = ${fx("t2")}`,
      ),
    );
    expect(row.rows[0]).toEqual({
      completed: true,
      completed_by: null,
      completed_reason: "actual_amount_received",
    });
    const again = await asCreator((tx) =>
      autoCompleteTasks(
        tx,
        seeded.householdId,
        { type: "actual_amount_received", itemId: fx("b-power") },
        seeded.userIds.creator,
      ),
    );
    expect(again).toEqual([]);
    const audit = await asCreator((tx) =>
      tx.execute(
        sql`select 1 from audit_events where entity_id = ${fx("t2")} and action = 'task.auto_completed'`,
      ),
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("ignores other items and other event types", async () => {
    const wrongItem = await asCreator((tx) =>
      autoCompleteTasks(
        tx,
        seeded.householdId,
        { type: "actual_amount_received", itemId: fx("b-water") },
        seeded.userIds.creator,
      ),
    );
    const wrongType = await asCreator((tx) =>
      autoCompleteTasks(
        tx,
        seeded.householdId,
        { type: "item_reviewed", itemId: fx("b-power") },
        seeded.userIds.creator,
      ),
    );
    expect([...wrongItem, ...wrongType]).toEqual([]);
  });

  it("a worker records a system event", async () => {
    await worker.withJobTx(seeded.householdId, async (tx) => {
      await tx.execute(sql`insert into tasks (id, household_id, title, owner_type, source, auto_complete_rule)
        values (${fx("t-proposal")}, ${seeded.householdId}, 'Decide', 'both', 'engine',
          ${JSON.stringify({ type: "proposal_decided", proposalId: fx("p-1") })}::jsonb)`);
      const done = await autoCompleteTasks(
        tx,
        seeded.householdId,
        { type: "proposal_decided", proposalId: fx("p-1") },
        null,
      );
      expect(done).toHaveLength(1);
    });
    const audit = await asCreator((tx) =>
      tx.execute<{ actor_type: string }>(
        sql`select actor_type from audit_events where entity_id = ${fx("t-proposal")} and action = 'task.auto_completed'`,
      ),
    );
    expect(audit.rows[0]?.actor_type).toBe("system");
  });
});

describe("proposals: expiry and the decision rule", () => {
  const propose = (id: string, expiresAt: string) =>
    asCreator((tx) =>
      tx.execute(sql`insert into proposals (id, household_id, kind, payload, proposed_by, expires_at)
        values (${id}, ${seeded.householdId}, 'goal_change', ${JSON.stringify({ type: "goal_delete", goalId: id })}::jsonb,
          ${seeded.userIds.creator}, ${expiresAt}::timestamptz)`),
    );
  const status = async (id: string) =>
    (
      await asCreator((tx) =>
        tx.execute<{ status: string }>(sql`select status from proposals where id = ${id}`),
      )
    ).rows[0]?.status;

  it("expireProposals marks only overdue pending proposals, once", async () => {
    await propose(fx("p-old"), "2026-11-03T16:00:00Z");
    await propose(fx("p-new"), "2026-11-20T16:00:00Z");
    await asPartner((tx) =>
      tx.execute(sql`update proposals set status = 'rejected', decided_by = ${seeded.userIds.partner}
        where id = ${fx("p-old")}`),
    );
    await propose(fx("p-old2"), "2026-11-03T16:00:00Z");
    const first = await worker.withJobTx(seeded.householdId, (tx) =>
      expireProposals(tx, seeded.householdId, "2026-11-10T00:00:00Z"),
    );
    expect(first).toBe(1);
    expect(await status(fx("p-old2"))).toBe("expired");
    expect(await status(fx("p-old"))).toBe("rejected");
    expect(await status(fx("p-new"))).toBe("pending");
    const second = await worker.withJobTx(seeded.householdId, (tx) =>
      expireProposals(tx, seeded.householdId, "2026-11-10T00:00:00Z"),
    );
    expect(second).toBe(0);
  });

  it("the schema itself has the CHECK decided_by <> proposed_by, beyond the RLS policy", async () => {
    // Forced RLS hides every row from the migrator, so assert the constraint definition from the catalog.
    const client = new pg.Client({ connectionString: inject("migratorDatabaseUrl") });
    await client.connect();
    try {
      const res = await client.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'public.proposals'::regclass and contype = 'c'`,
      );
      expect(res.rows.map((r) => r.def)).toContain(
        "CHECK (((decided_by IS NULL) OR (decided_by <> proposed_by)))",
      );
    } finally {
      await client.end();
    }
  });
});
