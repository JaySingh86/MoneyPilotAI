// Planning API against a real Postgres (RLS as mp_api) with the real auth layer. The golden test: seed the
// Rivera fixture, and GET /plan returns exactly the fixture's `expected` values; the shortfall scenario
// returns `scenarios.shortfall.expected`. Every number here comes from @mp/engine through the API.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { planningUuid, seedFixture, seedPlanning, type SeedResult } from "@mp/db/testing";
import { createTestApi, key, type TestApi } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";

/* eslint-disable @typescript-eslint/no-explicit-any -- the fixture is read as loose JSON */
interface Fixture {
  expected: Record<string, any>;
  scenarios: { shortfall: { addPlannedExpenses: any[]; expected: Record<string, any> } };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Day {
  date: string;
  endBalanceCents: number;
}

let t: TestApi;
let worker: WorkerDb;
let fixture: Fixture;
let fixtureText: string;

interface World {
  seeded: SeedResult;
  tag: string;
  sam: Record<string, string>;
  jordan: Record<string, string>;
}
let base: World;
let short: World;

/** The fixture with member, household and address ids renamed, so this file owns its households. */
function renamed(tag: string): string {
  return fixtureText
    .replaceAll('"hh-rivera"', `"hh-rivera-${tag}"`)
    .replaceAll('"m-sam"', `"m-sam-${tag}"`)
    .replaceAll('"m-jordan"', `"m-jordan-${tag}"`)
    .replaceAll("rivera-household.example", `rivera-${tag}.example`)
    .replaceAll("rivera-7k2", `rivera-${tag}`);
}

async function seedWorld(tag: string): Promise<World> {
  const text = renamed(tag);
  const seeded = await seedFixture({ api: t.db, worker }, JSON.parse(text));
  await seedPlanning({ api: t.db, worker }, seeded, JSON.parse(text));
  return {
    seeded,
    tag,
    sam: await t.as(`fixture|m-sam-${tag}`, { claims: { email: `sam@rivera-${tag}.example` } }),
    jordan: await t.as(`fixture|m-jordan-${tag}`, { claims: { email: `jordan@rivera-${tag}.example` } }),
  };
}

const hh = (w: World) => `/v1/households/${w.seeded.householdId}`;
const fx = (w: World, id: string) => planningUuid(w.seeded.householdId, id);
const AS_OF = "2026-10-27";

let reads = 0;
/** Reads alternate between the household's two members: the compute budget is 60 a minute per user. */
async function get(w: World, path: string, headers?: Record<string, string>) {
  reads += 1;
  return t.app.inject({
    method: "GET",
    url: `${hh(w)}${path}`,
    headers: headers ?? (reads % 2 === 0 ? w.sam : w.jordan),
  });
}

/** Engine owner keys are user ids; the fixture uses member ids. */
function memberIds(w: World): Record<string, string> {
  return { [w.seeded.userIds.creator]: "m-sam", [w.seeded.userIds.partner]: "m-jordan" };
}

beforeAll(async () => {
  t = await createTestApi();
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  fixtureText = await readFile(
    fileURLToPath(new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url)),
    "utf8",
  );
  fixture = JSON.parse(fixtureText) as Fixture;
  base = await seedWorld("wp12a");
  short = await seedWorld("wp12b");
  // The shortfall scenario adds one planned expense, the way a member would: through the API.
  const add = fixture.scenarios.shortfall.addPlannedExpenses[0];
  const res = await t.app.inject({
    method: "POST",
    url: `${hh(short)}/planned-expenses`,
    headers: { ...short.sam, ...key() },
    payload: { name: add.name, amountCents: add.amountCents, dueOn: add.date, ownerType: "both" },
  });
  expect(res.statusCode, res.body).toBe(201);
}, 240_000);

afterAll(async () => {
  await t?.close();
  await worker?.close();
});

describe("GET /plan · golden (on track)", () => {
  it("returns exactly the fixture's expected values", async () => {
    const res = await get(base, `/plan?asOf=${AS_OF}`);
    expect(res.statusCode, res.body).toBe(200);
    const plan = res.json();
    const e = fixture.expected;
    expect(plan.asOf).toBe(AS_OF);
    expect(plan.cushionCents).toBe(50000);
    expect(plan.window).toEqual(e.planningWindow);
    expect(Object.fromEntries(plan.runway.map((d: Day) => [d.date, d.endBalanceCents]))).toEqual(
      e.runwayEndOfDayCents,
    );
    expect(plan.lowest).toEqual(e.lowest);
    expect(plan.state).toBe("on_track");
    expect(plan.safeToSpendCents).toBe(e.safeToSpendCents);
    expect(plan.safeToSpendDisplayCents).toBe(100700); // "$1,007"
    expect(plan.shortfallDisplayCents).toBeNull();
    expect(plan.perDayCents).toBe(10000); // "≈ $100 a day"
    expect(plan.belowCushionFrom).toBeNull();
    expect(plan.belowZeroDates).toEqual([]);
    const owners = memberIds(base);
    expect(plan.billsBeforePayday.count).toBe(e.billsBeforePayday.count);
    expect(plan.billsBeforePayday.totalCents).toBe(e.billsBeforePayday.totalCents);
    expect(
      Object.fromEntries(
        Object.entries(plan.billsBeforePayday.byOwner as Record<string, number>).map(([k, v]) => [
          owners[k] ?? k,
          v,
        ]),
      ),
    ).toEqual(e.billsBeforePayday.byOwner);
  });

  it("carries the flags, the ranked decisions and the math that the Overview shows", async () => {
    const plan = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    const carIns = fx(base, "b-carins");
    expect(plan.flags).toContainEqual(
      expect.objectContaining({ code: "not_usual_month", subjectId: carIns, date: "2026-11-04" }),
    );
    expect(plan.decisions[0]).toMatchObject({
      rank: 1,
      kind: "not_usual_month",
      subjectId: carIns,
      aiText: null,
    });
    expect(plan.shortfallOptions).toEqual([]);
    const total = plan.math.find((m: { role: string }) => m.role === "total");
    expect(total).toMatchObject({ id: "safe_to_spend", cents: fixture.expected.safeToSpendCents });
  });

  it("defaults asOf to the household's local today", async () => {
    const plan = (await get(base, "/plan")).json();
    expect(plan.asOf).toBe(AS_OF); // the test clock is 2026-10-27T16:00Z, 12:00 in New York
  });
});

describe("GET /plan · golden (shortfall scenario)", () => {
  it("returns scenarios.shortfall.expected", async () => {
    const res = await get(short, `/plan?asOf=${AS_OF}`);
    expect(res.statusCode, res.body).toBe(200);
    const plan = res.json();
    const e = fixture.scenarios.shortfall.expected;
    expect(plan.state).toBe("shortfall");
    expect(Object.fromEntries(plan.runway.map((d: Day) => [d.date, d.endBalanceCents]))).toEqual(
      e.runwayEndOfDayCents,
    );
    expect(plan.lowest).toEqual(e.lowest);
    expect(plan.safeToSpendCents).toBe(e.safeToSpendCents);
    expect(plan.shortfallDisplayCents).toBe(79300); // "$793 short"
    expect(plan.safeToSpendDisplayCents).toBeNull();
    expect(plan.belowCushionFrom).toBe(e.belowCushionFrom);
    expect(plan.belowZeroDates).toEqual(e.belowZeroDates);
    expect(plan.billsBeforePayday.count).toBe(e.itemsBeforePayday.count);
    expect(plan.billsBeforePayday.totalCents).toBe(e.itemsBeforePayday.totalCents);
  });

  it("lists the three ways to cover the gap, in order, with the fixture's results", async () => {
    const plan = (await get(short, `/plan?asOf=${AS_OF}`)).json();
    const [fund, split, move] = plan.shortfallOptions;
    const [eFund, eSplit, eMove] = fixture.scenarios.shortfall.expected.options;
    expect(plan.shortfallOptions.map((o: { kind: string }) => o.kind)).toEqual([
      "move_from_emergency_fund",
      "split_expense",
      "move_bill_to_payday",
    ]);
    expect(fund.amountCents).toBe(eFund.amountCents);
    expect(fund.result.safeToSpendCents).toBe(eFund.safeToSpendCents);
    expect(split.amountNowCents).toBe(eSplit.amountNowCents);
    expect(split.amountAfterPaydayCents).toBe(eSplit.amountAfterPaydayCents);
    expect(split.result.safeToSpendCents).toBe(eSplit.safeToSpendCents);
    expect(move.result.safeToSpendCents).toBe(eMove.safeToSpendCents);
    expect(move.result.minBalanceCents).toBe(eMove.minBalanceCents);
    expect(plan.decisions[0].kind).toBe("shortfall");
  });
});

describe("snapshots", () => {
  it("calcSnapshotId is stable across identical reads and stored once", async () => {
    const a = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    const b = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    expect(a.calcSnapshotId).toBe(b.calcSnapshotId);
    const res = await get(base, `/plan?asOf=${AS_OF}`);
    expect(res.headers.etag).toBe(`"${a.calcSnapshotId}"`);
    const n = await t.admin(async (c) => {
      const r = await c.query(
        "select count(*)::int as n from calc_snapshots where household_id = $1 and as_of = $2",
        [base.seeded.householdId, AS_OF],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(1);
    const stored = await t.admin(async (c) => {
      const r = await c.query("select result from calc_snapshots where id = $1", [a.calcSnapshotId]);
      return (r.rows[0] as { result: { safeToSpendCents: number; engineVersion: string } }).result;
    });
    expect(stored.safeToSpendCents).toBe(fixture.expected.safeToSpendCents);
    expect(stored.engineVersion).toBe(a.engineVersion);
  });

  it("only today's plan is stored: another date is computed and returned without a snapshot (M1)", async () => {
    const before = await t.admin(async (c) => {
      const r = await c.query("select count(*)::int as n from calc_snapshots where household_id = $1", [
        base.seeded.householdId,
      ]);
      return (r.rows[0] as { n: number }).n;
    });
    const res = await get(base, "/plan?asOf=2026-10-28");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().calcSnapshotId).toBeNull();
    expect(res.headers.etag).toBeUndefined();
    const after = await t.admin(async (c) => {
      const r = await c.query("select count(*)::int as n from calc_snapshots where household_id = $1", [
        base.seeded.householdId,
      ]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(after).toBe(before);
  });

  it("answers 304 to a matching If-None-Match and a full plan to a stale one", async () => {
    const first = await get(base, `/plan?asOf=${AS_OF}`);
    const etag = first.headers.etag as string;
    const same = await t.app.inject({
      method: "GET",
      url: `${hh(base)}/plan?asOf=${AS_OF}`,
      headers: { ...base.sam, "if-none-match": etag },
    });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe("");
    expect(same.headers.etag).toBe(etag);
    const stale = await t.app.inject({
      method: "GET",
      url: `${hh(base)}/plan?asOf=${AS_OF}`,
      headers: { ...base.sam, "if-none-match": '"00000000-0000-4000-8000-000000000000"' },
    });
    expect(stale.statusCode).toBe(200);
  });
});

describe("POST /plan/what-if", () => {
  const whatIf = (w: World, changes: unknown[]) =>
    t.app.inject({
      method: "POST",
      url: `${hh(w)}/plan/what-if`,
      headers: w.sam,
      payload: { changes, asOf: AS_OF },
    });

  async function occurrenceOf(w: World, itemId: string, on: string): Promise<string> {
    const res = await get(w, `/occurrences?from=${on}&to=${on}&itemId=${fx(w, itemId)}`);
    const row = (res.json().data as { id: string }[])[0];
    if (!row) throw new Error(`no occurrence of ${itemId} on ${on}`);
    return row.id;
  }

  it("moving car insurance to payday gives the fixture's safe to spend, and writes nothing", async () => {
    const before = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    const occurrenceId = await occurrenceOf(base, "b-carins", "2026-11-04");
    const res = await whatIf(base, [{ type: "move_occurrence", occurrenceId, toDate: "2026-11-06" }]);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.before.safeToSpendCents).toBe(fixture.expected.safeToSpendCents);
    expect(body.after.safeToSpendCents).toBe(fixture.expected.safeToSpendIfCarInsuranceMovedToPaydayCents);
    expect(body.diff).toMatchObject({
      stateBefore: "on_track",
      stateAfter: "on_track",
      deltaCents: 169101 - 100701,
      changesSafeToSpend: true,
    });
    expect((await get(base, `/plan?asOf=${AS_OF}`)).json().calcSnapshotId).toBe(before.calcSnapshotId);
    const moved = await get(
      base,
      `/occurrences?from=2026-11-04&to=2026-11-04&itemId=${fx(base, "b-carins")}`,
    );
    expect(moved.json().data).toHaveLength(1); // still on Nov 4
  });

  it("an actual electricity amount of $151.37 gives the fixture's value", async () => {
    const occurrenceId = await occurrenceOf(base, "b-power", "2026-11-03");
    const res = await whatIf(base, [{ type: "set_actual_amount", occurrenceId, amountCents: 15137 }]);
    const after = res.json().after;
    expect(after.safeToSpendCents).toBe(fixture.expected.safeToSpendAfterElectricityActual15137Cents);
    expect(after.safeToSpendDisplayCents).toBe(99700); // "$997": floored, never rounded up (Q-018)
  });

  it("splits a planned expense and rejects what does not apply", async () => {
    const planned = (await get(base, "/planned-expenses")).json().data[0] as { id: string };
    const ok = await whatIf(base, [
      {
        type: "split_planned_expense",
        plannedExpenseId: planned.id,
        amountNowCents: 10000,
        laterOn: "2026-11-07",
      },
    ]);
    expect(ok.statusCode, ok.body).toBe(200);
    expectProblem(
      await whatIf(base, [
        {
          type: "move_occurrence",
          occurrenceId: "00000000-0000-4000-8000-0000000000aa",
          toDate: "2026-11-06",
        },
      ]),
      404,
      "not_found",
    );
    expectProblem(await whatIf(base, []), 400, "validation_failed");
    expectProblem(
      await whatIf(base, [
        { type: "set_item_amount", itemId: "00000000-0000-4000-8000-0000000000aa", amountCents: 1 },
      ]),
      400,
      "validation_failed",
    );
  });
});

describe("GET /calendar", () => {
  it("November's at-a-glance totals equal expected.november", async () => {
    const res = await get(base, `/calendar?month=2026-11&asOf=${AS_OF}`);
    expect(res.statusCode, res.body).toBe(200);
    const cal = res.json();
    expect(cal.month).toBe("2026-11");
    expect(cal.summary).toMatchObject({
      incomeCents: fixture.expected.november.incomeCents,
      billsCount: fixture.expected.november.billsCount,
      billsCents: fixture.expected.november.billsCents,
      goalsAndPlannedCents: fixture.expected.november.goalsAndPlannedCents,
      leftForEverydayCents: fixture.expected.november.leftForEverydayCents,
    });
    expect(cal.days).toHaveLength(30);
    // Paydays are the primary income's (Sam's biweekly pay); Jordan's Nov 27 pay is an income chip only.
    expect(
      cal.days.filter((d: { isPayday: boolean }) => d.isPayday).map((d: { date: string }) => d.date),
    ).toEqual(["2026-11-06", "2026-11-20"]);
  });

  it("filters by owner (rule 13)", async () => {
    const all = (await get(base, `/calendar?month=2026-11&asOf=${AS_OF}`)).json();
    const jordan = base.seeded.userIds.partner;
    const mine = (await get(base, `/calendar?month=2026-11&asOf=${AS_OF}&owner=${jordan}`)).json();
    const owners = new Set(
      mine.days.flatMap((d: { entries: { owner: string }[] }) => d.entries.map((e) => e.owner)),
    );
    expect([...owners].every((o) => o === jordan || o === "both" || o === "split")).toBe(true);
    expect(mine.summary.billsCents).toBeLessThan(all.summary.billsCents);
  });

  it("rejects a malformed month", async () => {
    expectProblem(await get(base, "/calendar?month=2026-13"), 400, "validation_failed");
    expectProblem(await get(base, "/calendar"), 400, "validation_failed");
  });
});

describe("renewals", () => {
  it("the summary equals expected.renewals", async () => {
    const res = await get(base, `/renewals/summary?asOf=${AS_OF}`);
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    const e = fixture.expected.renewals;
    expect(s.count).toBe(e.count);
    expect(s.yearlyCents).toBe(e.yearlyCents);
    expect(s.next90Days.cents).toBe(e.bigRenewalsNext90DaysCents);
    expect(s.priceIncreaseYearlyCents).toBe(e.priceIncreaseYearlyCents);
    expect(s.couldSaveYearlyCents).toBe(e.couldSaveYearlyCents);
    expect(s.foundAutomatically).toBe(e.foundAutomatically);
    expect(s).not.toHaveProperty("rows");
  });

  it("lists every renewal once, sorted by the next action, and filters by category", async () => {
    const all = (await get(base, `/renewals?asOf=${AS_OF}`)).json().data as {
      id: string;
      category: string;
      nextActionOn: string;
    }[];
    expect(all).toHaveLength(fixture.expected.renewals.count);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(all.map((r) => r.nextActionOn)).toEqual([...all.map((r) => r.nextActionOn)].sort());
    const insurance = (await get(base, `/renewals?category=insurance&asOf=${AS_OF}`)).json().data as {
      category: string;
    }[];
    expect(insurance.length).toBeGreaterThan(0);
    expect(insurance.every((r) => r.category === "insurance")).toBe(true);
    expectProblem(await get(base, "/renewals?category=bogus"), 400, "validation_failed");
  });
});

describe("bills averages on the items list", () => {
  it("?include=averages returns expected.billsPage; renewal-only items are excluded (rule 17)", async () => {
    const res = await get(base, "/items?onBillsPage=true&limit=100&include=averages");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const e = fixture.expected.billsPage;
    expect(body.averages).toMatchObject({
      rows: e.rows,
      monthlyBillsAverageCents: e.monthlyBillsAverageCents,
      monthlyIncomeAverageCents: e.monthlyIncomeAverageCents,
      leftAfterBillsCents: e.leftAfterBillsCents,
      estimatesToConfirm: e.estimatesToConfirm,
    });
    expect(body.data).toHaveLength(18);
  });

  it("is absent unless asked for", async () => {
    const body = (await get(base, "/items?limit=5")).json();
    expect(body).not.toHaveProperty("averages");
  });
});

describe("access", () => {
  it("anonymous callers get 401 and strangers get 404 on every planning route", async () => {
    const stranger = await t.signUp("planning-stranger");
    const paths = [`/plan?asOf=${AS_OF}`, "/calendar?month=2026-11", "/renewals", "/renewals/summary"];
    for (const p of paths) {
      const anon = await t.app.inject({ method: "GET", url: `${hh(base)}${p}` });
      expectProblem(anon, 401, "unauthorized");
      expectProblem(await get(base, p, stranger.headers), 404, "not_found");
    }
    expectProblem(
      await t.app.inject({
        method: "POST",
        url: `${hh(base)}/plan/what-if`,
        headers: stranger.headers,
        payload: { changes: [{ type: "add_transfer", amountCents: 100, on: "2026-11-01" }] },
      }),
      404,
      "not_found",
    );
  });

  it("the partner reads the same plan", async () => {
    const sam = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    const jordan = (await get(base, `/plan?asOf=${AS_OF}`, base.jordan)).json();
    expect(jordan.calcSnapshotId).toBe(sam.calcSnapshotId);
  });

  it("a household without a primary income or a balance answers 409, not 500", async () => {
    const owner = await t.signUp("planning-new");
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/households",
      headers: { ...owner.headers, ...key() },
      payload: { name: "New household", timezone: "America/New_York" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/households/${id}/plan`,
      headers: owner.headers,
    });
    const problem = expectProblem(res, 409, "plan_not_ready");
    expect(problem).toMatchObject({ reason: "no_primary_income" });
    // renewals and averages need neither
    const renewals = await t.app.inject({
      method: "GET",
      url: `/v1/households/${id}/renewals/summary`,
      headers: owner.headers,
    });
    expect(renewals.statusCode, renewals.body).toBe(200);
    expect(renewals.json().count).toBe(0);
  });
});

describe("renewal-only items and plan recomputation", () => {
  it("a renewal-only item counts in the runway but not in the bills averages", async () => {
    const before = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    const created = await t.app.inject({
      method: "POST",
      url: `${hh(base)}/items`,
      headers: { ...base.sam, ...key() },
      payload: {
        direction: "outflow",
        kind: "insurance",
        category: "insurance",
        name: "Pet insurance",
        amountType: "fixed",
        amountCents: 5000,
        schedule: { type: "yearly", dtstart: "2026-11-02" },
        ownerType: "member",
        ownerUserId: base.seeded.userIds.creator,
        onBillsPage: false,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const after = (await get(base, `/plan?asOf=${AS_OF}`)).json();
    expect(after.safeToSpendCents).toBe(before.safeToSpendCents - 5000);
    expect(after.calcSnapshotId).not.toBe(before.calcSnapshotId);
    const averages = (await get(base, "/items?onBillsPage=true&limit=1&include=averages")).json().averages;
    expect(averages.monthlyBillsAverageCents).toBe(fixture.expected.billsPage.monthlyBillsAverageCents);
    expect(averages.rows).toBe(fixture.expected.billsPage.rows);
  });

  async function patchHousehold(w: World, payload: object) {
    const current = await t.app.inject({ method: "GET", url: hh(w), headers: w.sam });
    return t.app.inject({
      method: "PATCH",
      url: hh(w),
      headers: { ...w.sam, "if-match": current.headers.etag as string },
      payload,
    });
  }

  it("a cushion change gives a new snapshot and a new safe to spend on the next read (Q-056)", async () => {
    const before = (await get(short, `/plan?asOf=${AS_OF}`)).json();
    const res = await patchHousehold(short, { cushionCents: 20000 });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await get(short, `/plan?asOf=${AS_OF}`)).json();
    expect(after.cushionCents).toBe(20000);
    expect(after.calcSnapshotId).not.toBe(before.calcSnapshotId);
    expect(after.safeToSpendCents).toBe(before.safeToSpendCents + 30000);
  });

  it("a primary income change moves the planning window on the next read (Q-056)", async () => {
    const before = (await get(short, `/plan?asOf=${AS_OF}`)).json();
    const res = await patchHousehold(short, { primaryIncomeItemId: fx(short, "inc-jordan") });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await get(short, `/plan?asOf=${AS_OF}`)).json();
    expect(before.window.to).toBe("2026-11-06");
    expect(after.window.to).toBe("2026-10-30"); // Jordan is paid on the last Friday of October
    expect(after.calcSnapshotId).not.toBe(before.calcSnapshotId);
  });
});

describe("abuse bounds (security M1)", () => {
  const EXTREMES = ["0001-01-01", "9999-12-31", "2028-01-01", "2025-01-01"];
  const post = (w: World, payload: object) =>
    t.app.inject({ method: "POST", url: `${hh(w)}/plan/what-if`, headers: w.jordan, payload });

  it("GET /plan refuses an asOf more than 400 days from today, at both extremes", async () => {
    for (const asOf of EXTREMES) {
      expectProblem(await get(base, `/plan?asOf=${asOf}`), 400, "validation_failed");
    }
    // the edges are allowed: today +- 400 days
    expect((await get(base, "/plan?asOf=2027-12-01")).statusCode).toBe(200);
    expect((await get(base, "/plan?asOf=2026-10-27")).statusCode).toBe(200);
  });

  it("renewals and what-if refuse the same asOf", async () => {
    for (const asOf of EXTREMES.slice(0, 2)) {
      expectProblem(await get(base, `/renewals?asOf=${asOf}`), 400, "validation_failed");
      expectProblem(
        await post(base, { asOf, changes: [{ type: "add_transfer", amountCents: 100, on: "2026-11-01" }] }),
        400,
        "validation_failed",
      );
    }
  });

  it("GET /calendar refuses a month outside the range", async () => {
    for (const month of ["0001-01", "9999-12", "2030-01", "2024-01"]) {
      expectProblem(await get(base, `/calendar?month=${month}`), 400, "validation_failed");
    }
    expect((await get(base, "/calendar?month=2027-06")).statusCode).toBe(200);
  });

  it("what-if refuses dates in a change that are outside the range", async () => {
    const occ = (await get(base, `/occurrences?from=2026-11-04&to=2026-11-04`)).json().data[0] as {
      id: string;
    };
    const planned = (await get(base, "/planned-expenses")).json().data[0] as { id: string };
    for (const date of ["0001-01-01", "9999-12-31"]) {
      expectProblem(
        await post(base, { changes: [{ type: "add_transfer", amountCents: 100, on: date }] }),
        400,
        "validation_failed",
      );
      expectProblem(
        await post(base, { changes: [{ type: "move_occurrence", occurrenceId: occ.id, toDate: date }] }),
        400,
        "validation_failed",
      );
      expectProblem(
        await post(base, {
          changes: [
            {
              type: "split_planned_expense",
              plannedExpenseId: planned.id,
              amountNowCents: 100,
              laterOn: date,
            },
          ],
        }),
        400,
        "validation_failed",
      );
    }
  });
});

describe("data_missing flag (Q-107)", () => {
  it("an item without an amount is planned at $0 and flagged, not silently dropped", async () => {
    const itemId = await t.admin(async (c) => {
      const r = await c.query(
        `insert into recurring_items (household_id, direction, kind, category, name, amount_type, amount_cents,
           rrule, dtstart, owner_type, source, created_by)
         values ($1, 'outflow', 'bill', 'other', 'Legacy estimate', 'estimated', null, 'FREQ=MONTHLY;BYMONTHDAY=3',
           '2026-01-01', 'both', 'csv', $2) returning id`,
        [short.seeded.householdId, short.seeded.userIds.creator],
      );
      return (r.rows[0] as { id: string }).id;
    });
    const plan = (await get(short, `/plan?asOf=${AS_OF}`)).json();
    expect(plan.flags).toContainEqual({ code: "data_missing", subjectId: itemId, date: null });
  });
});

describe("compute rate limit (L1)", () => {
  it("plan, what-if and calendar share 60 requests a minute per user", async () => {
    const user = await t.signUp("planning-limit");
    const url = `${hh(base)}/plan`;
    let limited = 0;
    for (let i = 0; i < 61; i++) {
      const res = await t.app.inject({ method: "GET", url, headers: user.headers });
      if (res.statusCode === 429) limited += 1;
      else expect(res.statusCode).toBe(404); // not a member, but it counted
    }
    expect(limited).toBe(1);
    expectProblem(
      await t.app.inject({
        method: "GET",
        url: `${hh(base)}/calendar?month=2026-11`,
        headers: user.headers,
      }),
      429,
      "rate_limited",
    );
  });
});

describe("performance", () => {
  it("GET /plan p95 is under 300 ms for the fixture household (shortfall seed, the heavier plan)", async () => {
    await get(short, `/plan?asOf=${AS_OF}`); // warm the connection and the JIT
    reads = 0;
    const samples: number[] = [];
    for (let i = 0; i < 80; i++) {
      const start = performance.now();
      const res = await get(short, `/plan?asOf=${AS_OF}`);
      samples.push(performance.now() - start);
      expect(res.statusCode).toBe(200);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] as number;
    const p50 = samples[Math.floor(samples.length / 2)] as number;
    process.stdout.write(
      `GET /plan latency over ${samples.length} reads: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms\n`,
    );
    expect(p95).toBeLessThan(300);
  });
});
