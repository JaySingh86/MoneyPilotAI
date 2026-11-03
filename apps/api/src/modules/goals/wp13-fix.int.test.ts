// WP-13 fix round against a real Postgres: the monthly-amount bypasses closed (archive, withdrawals, goal
// creation), one pending proposal per target and the cap, payload re-parse, failed applies ending as
// superseded, no-balance and single-adult behavior, and the loader parity with the engine's Rivera plan.
// Every gated case runs in both directions (Sam and Jordan).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createWorkerDb, loadEngineInput, type WorkerDb } from "@mp/db";
import { planningUuid, seedFixture, seedPlanning, type SeedResult } from "@mp/db/testing";
import { computePlan } from "@mp/engine";
import { riveraInput } from "@mp/engine/testing";
import { createTestApi, key, type TestApi } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";

const NOW = "2026-10-27T16:00:00Z";
let t: TestApi;
let worker: WorkerDb;
let rawFixture: string;

interface Rivera {
  seeded: SeedResult;
  sam: Record<string, string>;
  jordan: Record<string, string>;
  fx: (id: string) => string;
  base: string;
}

async function seedRivera(suffix: string): Promise<Rivera> {
  const fixture: unknown = JSON.parse(
    rawFixture
      .replaceAll("hh-rivera", `hh-rivera-${suffix}`)
      .replaceAll("m-sam", `m-sam-${suffix}`)
      .replaceAll("m-jordan", `m-jordan-${suffix}`)
      .replaceAll("rivera-7k2", `rivera-${suffix}`)
      .replaceAll("@rivera-household.example", `@${suffix}.example`),
  );
  const seeded = await seedFixture({ api: t.db, worker }, fixture);
  await seedPlanning({ api: t.db, worker }, seeded, fixture);
  return {
    seeded,
    sam: await t.as(`fixture|m-sam-${suffix}`, { claims: { email: `sam@${suffix}.example` } }),
    jordan: await t.as(`fixture|m-jordan-${suffix}`, { claims: { email: `jordan@${suffix}.example` } }),
    fx: (id) => planningUuid(seeded.householdId, id),
    base: `/v1/households/${seeded.householdId}`,
  };
}

beforeAll(async () => {
  t = await createTestApi({ now: () => NOW });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  rawFixture = await readFile(
    fileURLToPath(new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url)),
    "utf8",
  );
}, 180_000);
afterAll(async () => {
  await t?.close();
  await worker?.close();
});

const call = (opts: InjectOptions) => t.app.inject(opts);

interface ProposalBody {
  id: string;
  status: string;
  proposedBy: string;
  decisionNote: string | null;
  payload: Record<string, unknown> & { type: string };
}

function pending(res: LightMyRequestResponse, type: string): ProposalBody {
  expect(res.statusCode, res.body).toBe(202);
  const body = res.json() as ProposalBody;
  expect(body.status).toBe("pending");
  expect(body.payload.type).toBe(type);
  return body;
}

class Api {
  constructor(readonly r: Rivera) {}
  get = (h: Record<string, string>, path: string) =>
    call({ method: "GET", url: `${this.r.base}${path}`, headers: h });
  post = (h: Record<string, string>, path: string, payload?: object) =>
    call({ method: "POST", url: `${this.r.base}${path}`, headers: { ...h, ...key() }, payload });
  patch = async (h: Record<string, string>, path: string, payload: object) => {
    const etag = (await this.get(h, path)).headers.etag as string;
    return call({
      method: "PATCH",
      url: `${this.r.base}${path}`,
      headers: { ...h, "if-match": etag },
      payload,
    });
  };
  del = (h: Record<string, string>, path: string) =>
    call({ method: "DELETE", url: `${this.r.base}${path}`, headers: h });
  approve = (h: Record<string, string>, id: string) => this.post(h, `/proposals/${id}/approve`);
  reject = (h: Record<string, string>, id: string) => this.post(h, `/proposals/${id}/reject`);
  settle = async () => {
    const open = (await this.get(this.r.sam, "/proposals?status=pending")).json().data as ProposalBody[];
    for (const p of open) {
      await this.reject(p.proposedBy === this.r.seeded.userIds.creator ? this.r.jordan : this.r.sam, p.id);
    }
  };
  goals = async () => (await this.get(this.r.sam, "/goals")).json();
}

type Side = {
  name: string;
  actor: (r: Rivera) => Record<string, string>;
  decider: (r: Rivera) => Record<string, string>;
};
const sides: Side[] = [
  { name: "Sam asks, Jordan decides", actor: (r) => r.sam, decider: (r) => r.jordan },
  { name: "Jordan asks, Sam decides", actor: (r) => r.jordan, decider: (r) => r.sam },
];

describe.each(sides)("monthly-amount bypasses are closed: $name", (side) => {
  let r: Rivera;
  let a: Api;
  beforeAll(async () => {
    r = await seedRivera(side.name.startsWith("Sam") ? "fixs" : "fixj");
    a = new Api(r);
  });
  beforeEach(() => a.settle());

  it("H1: archiving then restoring a goal with a monthly amount is a proposal; the plan doesn't move until approved", async () => {
    const id = r.fx("g-emergency");
    const before = await a.goals();
    expect(before.savingEachMonthCents).toBe(55000);
    const p = pending(await a.patch(side.actor(r), `/goals/${id}`, { status: "archived" }), "goal_status");
    expect(p.payload).toMatchObject({ fromStatus: "active", toStatus: "archived", monthlyCents: 30000 });
    const effect = p.payload.effect as { safeToSpendBeforeCents: number; safeToSpendAfterCents: number };
    expect(effect.safeToSpendBeforeCents).toBe(100701);
    // Still listed, still saving: nothing changed.
    const during = await a.goals();
    expect(during.savingEachMonthCents).toBe(55000);
    expect(during.data.map((g: { id: string }) => g.id)).toContain(id);
    expect((await a.get(r.sam, `/goals/${id}`)).json().status).toBe("active");
    // The asker can't approve it; the other member can.
    expectProblem(await a.approve(side.actor(r), p.id), 403, "forbidden");
    expect((await a.approve(side.decider(r), p.id)).statusCode).toBe(200);
    const after = await a.goals();
    expect(after.savingEachMonthCents).toBe(25000);
    expect(after.data.map((g: { id: string }) => g.id)).not.toContain(id);
    // Restoring it is a proposal too (the deposit comes back), approved the other way round.
    const back = pending(await a.patch(side.decider(r), `/goals/${id}`, { status: "active" }), "goal_status");
    expect(back.payload).toMatchObject({ fromStatus: "archived", toStatus: "active" });
    expect((await a.get(r.sam, `/goals/${id}`)).json().status).toBe("archived");
    expect((await a.approve(side.actor(r), back.id)).statusCode).toBe(200);
    expect((await a.goals()).savingEachMonthCents).toBe(55000);
  });

  it("H1: archiving a goal without a monthly amount, or sending status with other fields, behaves as specified", async () => {
    const gifts = r.fx("g-gifts"); // monthly 0
    expect((await a.patch(side.actor(r), `/goals/${gifts}`, { status: "archived" })).statusCode).toBe(200);
    expect((await a.patch(side.actor(r), `/goals/${gifts}`, { status: "active" })).statusCode).toBe(200);
    expectProblem(
      await a.patch(side.actor(r), `/goals/${r.fx("g-tahoe")}`, { status: "archived", name: "Trip" }),
      400,
      "validation_failed",
    );
  });

  it("M2: withdrawing from the emergency fund or a goal with a monthly amount is a proposal; deposits stay direct", async () => {
    const fund = r.fx("g-emergency");
    const w = pending(
      await a.post(side.actor(r), `/goals/${fund}/events`, {
        kind: "withdrawal",
        amountCents: 10000,
        note: "Car",
      }),
      "goal_withdrawal",
    );
    expect(w.payload).toMatchObject({ kind: "withdrawal", amountCents: 10000, goalId: fund });
    expect((await a.get(r.sam, `/goals/${fund}`)).json().savedCents).toBe(640000);
    expect((await a.approve(side.decider(r), w.id)).statusCode).toBe(200);
    expect((await a.get(r.sam, `/goals/${fund}`)).json().savedCents).toBe(630000);

    const tahoe = r.fx("g-tahoe"); // monthly 25000
    const adj = pending(
      await a.post(side.actor(r), `/goals/${tahoe}/events`, { kind: "adjustment", amountCents: -500 }),
      "goal_withdrawal",
    );
    expect((await a.reject(side.decider(r), adj.id)).statusCode).toBe(200);
    expect((await a.get(r.sam, `/goals/${tahoe}`)).json().savedCents).toBe(115000);

    const deposit = await a.post(side.actor(r), `/goals/${fund}/events`, {
      kind: "deposit",
      amountCents: 5000,
    });
    expect(deposit.statusCode, deposit.body).toBe(201);
    const positive = await a.post(side.actor(r), `/goals/${tahoe}/events`, {
      kind: "adjustment",
      amountCents: 500,
    });
    expect(positive.statusCode).toBe(201);
    // Holiday gifts: no monthly amount and not the fund, so a withdrawal is direct.
    const gifts = await a.post(side.actor(r), `/goals/${r.fx("g-gifts")}/events`, {
      kind: "withdrawal",
      amountCents: 1000,
    });
    expect(gifts.statusCode, gifts.body).toBe(201);
    // More than the goal holds is a 400 at once, not a proposal.
    expectProblem(
      await a.post(side.actor(r), `/goals/${fund}/events`, { kind: "withdrawal", amountCents: 99999999 }),
      400,
      "validation_failed",
    );
  });

  it("M3: a new goal with a monthly amount is created with monthly 0 plus a pending proposal; target and date edits stay direct", async () => {
    const res = await a.post(side.actor(r), "/goals", {
      name: "Bike",
      type: "savings",
      targetCents: 120000,
      monthlyCents: 10000,
      targetDate: "2027-06-01",
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { goal: { id: string; monthlyCents: number }; proposal: ProposalBody };
    expect(body.goal.monthlyCents).toBe(0);
    expect(body.proposal.payload).toMatchObject({
      type: "goal_monthly",
      goalId: body.goal.id,
      fromMonthlyCents: 0,
      toMonthlyCents: 10000,
    });
    expect((await a.get(r.sam, `/goals/${body.goal.id}`)).json().monthlyCents).toBe(0);
    expect((await a.approve(side.decider(r), body.proposal.id)).statusCode).toBe(200);
    expect((await a.get(r.sam, `/goals/${body.goal.id}`)).json().monthlyCents).toBe(10000);
    // The engine derives deposits from the monthly amount only, so the target and date don't move the plan.
    const edited = await a.patch(side.actor(r), `/goals/${body.goal.id}`, {
      targetCents: 150000,
      targetDate: "2027-09-01",
    });
    expect(edited.statusCode, edited.body).toBe(200);
    // Without a monthly amount a goal is created at once.
    const plain = await a.post(side.actor(r), "/goals", {
      name: "Books",
      type: "savings",
      targetCents: 5000,
    });
    expect(plain.statusCode, plain.body).toBe(201);
  });

  it("a target that crosses the saved amount moves the plan, so it is a proposal (the engine skips reached goals)", async () => {
    const tahoe = r.fx("g-tahoe"); // saved 115000, target 240000, monthly 25000
    const base = (await a.goals()).savingEachMonthCents as number; // Tahoe's 25000 is part of it
    // Not crossing: still above what is saved, so direct.
    expect((await a.patch(side.actor(r), `/goals/${tahoe}`, { targetCents: 200000 })).statusCode).toBe(200);
    const low = pending(
      await a.patch(side.actor(r), `/goals/${tahoe}`, { targetCents: 115000 }),
      "goal_target",
    );
    expect(low.payload).toMatchObject({
      fromTargetCents: 200000,
      toTargetCents: 115000,
      monthlyCents: 25000,
    });
    expect((await a.goals()).savingEachMonthCents).toBe(base);
    expect((await a.get(r.sam, `/goals/${tahoe}`)).json().targetCents).toBe(200000);
    expectProblem(await a.approve(side.actor(r), low.id), 403, "forbidden");
    expect((await a.approve(side.decider(r), low.id)).statusCode).toBe(200);
    expect((await a.get(r.sam, `/goals/${tahoe}`)).json()).toMatchObject({
      targetCents: 115000,
      status: "reached",
    });
    expect((await a.goals()).savingEachMonthCents).toBe(base - 25000);
    // Raising it on a reached goal puts the deposit back: a proposal too, approved the other way round.
    const high = pending(
      await a.patch(side.decider(r), `/goals/${tahoe}`, { targetCents: 300000 }),
      "goal_target",
    );
    expect((await a.goals()).savingEachMonthCents).toBe(base - 25000);
    expect((await a.approve(side.actor(r), high.id)).statusCode).toBe(200);
    expect((await a.goals()).savingEachMonthCents).toBe(base);
    // With other fields in the request it is refused; a goal without a monthly amount is edited directly.
    expectProblem(
      await a.patch(side.actor(r), `/goals/${tahoe}`, { targetCents: 100000, name: "Trip" }),
      400,
      "validation_failed",
    );
    expect(
      (await a.patch(side.actor(r), `/goals/${r.fx("g-gifts")}`, { targetCents: 10000 })).statusCode,
    ).toBe(200);
  });

  it("a stale target proposal is superseded", async () => {
    const tahoe = r.fx("g-tahoe");
    const p = pending(await a.patch(side.actor(r), `/goals/${tahoe}`, { targetCents: 50000 }), "goal_target");
    await t.admin((c) => c.query("update goals set target_cents = 260000 where id = $1", [tahoe]));
    expectProblem(await a.approve(side.decider(r), p.id), 409, "conflict");
  });

  it("M4: one pending proposal per type and target, and at most 20 open per household", async () => {
    const tahoe = r.fx("g-tahoe");
    const first = pending(
      await a.patch(side.actor(r), `/goals/${tahoe}`, { monthlyCents: 26000 }),
      "goal_monthly",
    );
    expectProblem(await a.patch(side.actor(r), `/goals/${tahoe}`, { monthlyCents: 27000 }), 409, "conflict");
    expectProblem(
      await a.patch(side.decider(r), `/goals/${tahoe}`, { monthlyCents: 27000 }),
      409,
      "conflict",
    );
    expectProblem(
      await a.post(side.actor(r), "/proposals", { type: "goal_monthly", goalId: tahoe, monthlyCents: 28000 }),
      409,
      "conflict",
    );
    // Decided, it can be asked again.
    expect((await a.reject(side.decider(r), first.id)).statusCode).toBe(200);
    pending(await a.patch(side.actor(r), `/goals/${tahoe}`, { monthlyCents: 27000 }), "goal_monthly");
    await a.settle();

    const owner = side.decider(r);
    const ownerId = owner === r.jordan ? r.seeded.userIds.partner : r.seeded.userIds.creator;
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await a.post(owner, "/planned-expenses", {
        name: `Cap ${i}`,
        amountCents: 1000,
        dueOn: "2026-12-01",
        ownerType: "member",
        ownerUserId: ownerId,
      });
      ids.push(res.json().id);
    }
    for (const id of ids.slice(0, 20))
      pending(await a.del(side.actor(r), `/planned-expenses/${id}`), "planned_delete");
    expectProblem(await a.del(side.actor(r), `/planned-expenses/${ids[20]}`), 409, "conflict");
  });

  it("L1: a stored payload that doesn't parse is never applied", async () => {
    const p = pending(
      await a.patch(side.actor(r), `/goals/${r.fx("g-tahoe")}`, { monthlyCents: 29000 }),
      "goal_monthly",
    );
    await t.admin((c) =>
      c.query(`update proposals set payload = '{"type":"bogus"}'::jsonb where id = $1`, [p.id]),
    );
    expectProblem(await a.approve(side.decider(r), p.id), 409, "conflict");
    const status = await t.admin((c) => c.query("select status from proposals where id = $1", [p.id]));
    expect(status.rows[0].status).toBe("superseded");
    expect((await a.get(r.sam, `/goals/${r.fx("g-tahoe")}`)).json().monthlyCents).toBe(25000);
  });
});

describe("L4: an apply that fails ends the proposal instead of leaving it pending", () => {
  let r: Rivera;
  let a: Api;
  beforeAll(async () => {
    r = await seedRivera("fixl");
    a = new Api(r);
  });

  it.each([
    ["pausing the primary income", { status: "paused" }],
    ["deleting the primary income", null],
  ] as const)("%s", async (_name, patch) => {
    const income = r.fx("inc-sam"); // the primary income, Sam's
    const res = patch
      ? await a.patch(r.jordan, `/items/${income}`, patch)
      : await a.del(r.jordan, `/items/${income}`);
    const p = pending(res, patch ? "item_patch" : "item_delete");
    expectProblem(await a.approve(r.sam, p.id), 409, "conflict");
    const after = (await a.get(r.sam, `/proposals/${p.id}`)).json() as ProposalBody;
    expect(after.status).toBe("superseded");
    expect(after.decisionNote).toBeTruthy();
    expect((await a.get(r.sam, `/items/${income}`)).json().status).toBe("active");
  });
});

describe("single adult: nobody else can approve, so goal changes apply directly", () => {
  it("archiving, withdrawing and creating with a monthly amount apply at once", async () => {
    const r = await seedRivera("fixo");
    const a = new Api(r);
    await t.admin((c) =>
      c.query(`update household_members set left_at = now() where household_id = $1 and user_id = $2`, [
        r.seeded.householdId,
        r.seeded.userIds.partner,
      ]),
    );
    const fund = r.fx("g-emergency");
    expect(
      (await a.post(r.sam, `/goals/${fund}/events`, { kind: "withdrawal", amountCents: 10000 })).statusCode,
    ).toBe(201);
    const created = await a.post(r.sam, "/goals", {
      name: "Solo",
      type: "savings",
      targetCents: 10000,
      monthlyCents: 500,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().monthlyCents).toBe(500);
    expect((await a.patch(r.sam, `/goals/${fund}`, { status: "archived" })).statusCode).toBe(200);
    expectProblem(
      await a.post(r.sam, "/proposals", { type: "goal_monthly", goalId: r.fx("g-tahoe"), monthlyCents: 1 }),
      409,
      "conflict",
    );
  });
});

describe("no balance: goals read, effects don't", () => {
  it("goal reads work; shortfall options and effects answer 409 plan_not_ready (no_balance)", async () => {
    const r = await seedRivera("fixb");
    const a = new Api(r);
    await t.admin((c) => c.query(`delete from balances where household_id = $1`, [r.seeded.householdId]));
    const list = await a.get(r.sam, "/goals");
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(3);
    const options = await a.post(r.sam, "/proposals", { type: "shortfall_option", option: "split_expense" });
    expectProblem(options, 409, "plan_not_ready");
    expect(options.json().reason).toBe("no_balance");
    const monthly = await a.patch(r.sam, `/goals/${r.fx("g-tahoe")}`, { monthlyCents: 31300 });
    expectProblem(monthly, 409, "plan_not_ready");
    expect(monthly.json().reason).toBe("no_balance");
    // Without a primary income the goal read can't plan deposits either.
    await t.admin((c) =>
      c.query(`update households set primary_income_item_id = null where id = $1`, [r.seeded.householdId]),
    );
    const none = await a.get(r.sam, "/goals");
    expectProblem(none, 409, "plan_not_ready");
    expect(none.json().reason).toBe("no_primary_income");
  });
});

describe("the loader the goal routes use is the planning projection (Q-111)", () => {
  it("gives the same safe to spend as the engine's Rivera plan: $1,007.01", async () => {
    const r = await seedRivera("fixp");
    const loaded = await t.db.withHouseholdTx(
      { userId: r.seeded.userIds.creator, householdId: r.seeded.householdId },
      (tx) => loadEngineInput(tx, r.seeded.householdId, { nowIso: NOW }),
    );
    expect(loaded?.ready).toBe(true);
    if (!loaded?.ready) return;
    const fromRows = computePlan(loaded.input);
    const golden = computePlan(riveraInput());
    expect(fromRows.safeToSpendCents).toBe(100701);
    expect(fromRows.safeToSpendCents).toBe(golden.safeToSpendCents);
    expect(fromRows.lowest).toEqual(golden.lowest);
    expect(fromRows.window).toEqual(golden.window);
  });
});
