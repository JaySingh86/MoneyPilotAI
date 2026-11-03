// WP-13 fix round (security review M1, M4, L1, L2): a decision always names a decider who is not the
// proposer, only the kinds the service creates, one pending proposal per target, and plain user tasks only.
// Both directions (Sam and Jordan) are covered. Connects as mp_api / mp_worker only.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { expectDenied, expectRejected, openDbs, pgCode } from "./helpers";
import { buildWorld, type World } from "./world";

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

/** Refused by the policy (42501) or by the CHECK (23514). */
async function refused(run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the statement to be rejected").toBeDefined();
  expect(["42501", "23514"]).toContain(pgCode(caught));
}

type As = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const sides = [
  [
    "Sam proposes, Jordan decides",
    () => ({
      proposer: world.a.creator.id,
      decider: world.a.partner.id,
      asProposer: asCreator as As,
      asDecider: asPartner as As,
    }),
  ],
  [
    "Jordan proposes, Sam decides",
    () => ({
      proposer: world.a.partner.id,
      decider: world.a.creator.id,
      asProposer: asPartner as As,
      asDecider: asCreator as As,
    }),
  ],
] as const;

describe.each(sides)("proposals: %s (M1)", (_name, side) => {
  async function propose(): Promise<string> {
    const { proposer, asProposer } = side();
    return asProposer(async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`insert into proposals
          (household_id, kind, payload, proposed_by, expires_at)
        values (${world.a.id}, 'goal_change', ${JSON.stringify({ type: "goal_delete", goalId: randomUUID() })}::jsonb,
          ${proposer}, now() + interval '7 days') returning id`);
      return res.rows[0]?.id ?? "";
    });
  }

  it("nobody can set approved, rejected or applied with a null decider", async () => {
    const { asProposer, asDecider } = side();
    for (const status of ["approved", "rejected", "applied"]) {
      const id = await propose();
      await refused(() =>
        asProposer((tx) => tx.execute(sql`update proposals set status = ${status} where id = ${id}`)),
      );
      await refused(() =>
        asDecider((tx) => tx.execute(sql`update proposals set status = ${status} where id = ${id}`)),
      );
    }
  });

  it("the proposer can't mark their own proposal applied, with or without naming themselves", async () => {
    const { proposer, asProposer } = side();
    const id = await propose();
    await refused(() =>
      asProposer((tx) => tx.execute(sql`update proposals set status = 'applied' where id = ${id}`)),
    );
    await refused(() =>
      asProposer((tx) =>
        tx.execute(sql`update proposals set status = 'applied', decided_by = ${proposer} where id = ${id}`),
      ),
    );
  });

  it("superseded and expired never carry a decider, and the service can record them without one", async () => {
    const { decider, asDecider } = side();
    const id = await propose();
    await refused(() =>
      asDecider((tx) =>
        tx.execute(sql`update proposals set status = 'superseded', decided_by = ${decider} where id = ${id}`),
      ),
    );
    const res = await asDecider((tx) =>
      tx.execute(sql`update proposals set status = 'superseded', decision_note = 'changed' where id = ${id}`),
    );
    expect(res.rowCount).toBe(1);
  });

  it("the other member can decide it", async () => {
    const { decider, asDecider } = side();
    const id = await propose();
    const res = await asDecider((tx) =>
      tx.execute(
        sql`update proposals set status = 'applied', decided_by = ${decider}, decided_at = now() where id = ${id}`,
      ),
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("proposals: only the kinds the service creates; one pending per target (L1, M4)", () => {
  const insert = (kind: string, payload: object) =>
    asCreator((tx) =>
      tx.execute(sql`insert into proposals (household_id, kind, payload, proposed_by, expires_at)
        values (${world.a.id}, ${kind}, ${JSON.stringify(payload)}::jsonb, ${world.a.creator.id},
          now() + interval '7 days')`),
    );

  it("plan_option is not insertable by the API", async () => {
    await expectDenied(() => insert("plan_option", { type: "goal_delete" }));
  });

  it("a second pending proposal of one type for one target is refused; other targets, types and decided ones are fine", async () => {
    const goal = randomUUID();
    await insert("goal_change", { type: "goal_monthly", goalId: goal });
    await expectRejected(
      () => insert("goal_change", { type: "goal_monthly", goalId: goal }),
      UNIQUE_VIOLATION,
    );
    await insert("goal_change", { type: "goal_status", goalId: goal });
    await insert("goal_change", { type: "goal_monthly", goalId: randomUUID() });
    await asPartner((tx) =>
      tx.execute(sql`update proposals set status = 'rejected', decided_by = ${world.a.partner.id}
        where household_id = ${world.a.id} and payload->>'goalId' = ${goal} and payload->>'type' = 'goal_monthly'`),
    );
    await insert("goal_change", { type: "goal_monthly", goalId: goal });
  });

  it("occurrences of one item are separate targets", async () => {
    const item = randomUUID();
    await insert("item_change", { type: "occurrence_move", itemId: item, occurrenceId: randomUUID() });
    await insert("item_change", { type: "occurrence_move", itemId: item, occurrenceId: randomUUID() });
  });
});

describe("tasks: the API only writes plain user tasks (L2)", () => {
  const insert = (extra: { source?: string; rule?: object; dedupe?: string }) =>
    asCreator((tx) =>
      tx.execute(sql`insert into tasks (household_id, title, owner_type, source, auto_complete_rule, dedupe_key, created_by)
        values (${world.a.id}, 'Probe', 'both', ${extra.source ?? "user"},
          ${extra.rule ? JSON.stringify(extra.rule) : null}::jsonb, ${extra.dedupe ?? null}, ${world.a.creator.id})`),
    );

  it("rejects a source other than user, an auto-complete rule and a dedupe key", async () => {
    await insert({});
    await expectDenied(() => insert({ source: "engine" }));
    await expectDenied(() => insert({ source: "setup" }));
    await expectDenied(() => insert({ rule: { type: "item_reviewed", itemId: randomUUID() } }));
    await expectDenied(() => insert({ dedupe: `k-${randomUUID()}` }));
  });

  it("the worker still writes engine tasks with a rule and a key", async () => {
    await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`insert into tasks (household_id, title, owner_type, source, auto_complete_rule, dedupe_key)
        values (${world.a.id}, 'Engine', 'both', 'engine', '{"type":"item_reviewed","itemId":"x"}'::jsonb, ${`k-${randomUUID()}`})`),
    );
  });

  it("completed_by, when the API sets it, is the signed-in member (both directions)", async () => {
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`update tasks set completed_at = now(), completed_by = ${world.a.partner.id},
          completed_reason = 'manual' where id = ${world.a.items.taskId}`),
      ),
    );
    await expectDenied(() =>
      asPartner((tx) =>
        tx.execute(sql`update tasks set completed_at = now(), completed_by = ${world.a.creator.id},
          completed_reason = 'manual' where id = ${world.a.items.taskId}`),
      ),
    );
    await asPartner((tx) =>
      tx.execute(sql`update tasks set completed_at = now(), completed_by = ${world.a.partner.id},
        completed_reason = 'manual' where id = ${world.a.items.taskId}`),
    );
  });
});
