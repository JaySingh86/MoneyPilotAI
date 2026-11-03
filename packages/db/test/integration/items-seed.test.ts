// WP-06 acceptance on a real database: the seeded fixture's items and occurrences, the Q-020 renewal
// markers, the engine's bills page figures read back from stored rows, and the materializer rules.
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { billsAverages, scheduleFromRRule, type ItemInput, type ItemKind } from "@mp/engine";
import {
  extendOccurrences,
  materializeForJob,
  materializeHousehold,
  planOccurrences,
  rebuildFutureOccurrences,
} from "../../src/items/materialize";
import { planPlanningSeed, planningUuid, seedPlanning } from "../../src/seed/items";
import { seedFixture, type SeedResult } from "../../src/seed/rivera";
import { createApiDb, createWorkerDb, type ApiDb, type Tx, type WorkerDb } from "../../src/tx";
import { FIXTURE_PATH } from "../setup/paths";

const TODAY = "2026-10-27";
const fx = (id: string) => planningUuid(seeded.householdId, id);
let api: ApiDb;
let worker: WorkerDb;
let seeded: SeedResult;
let fixture: unknown;

const asCreator = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: seeded.userIds.creator, householdId: seeded.householdId }, fn);

beforeAll(async () => {
  api = createApiDb({ connectionString: inject("databaseUrl") });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl") });
  // The same golden household under its own identity, so this file does not race seed.test.ts (which seeds
  // the unmodified fixture into the same database) on household, member and forwarding-token uniqueness.
  const raw = (await readFile(FIXTURE_PATH, "utf8"))
    .replaceAll("hh-rivera", "hh-rivera-items")
    .replaceAll("m-sam", "m-sam-items")
    .replaceAll("m-jordan", "m-jordan-items")
    .replaceAll("rivera-7k2", "rivera-items")
    .replaceAll("@rivera-household.example", "@items.example");
  fixture = JSON.parse(raw);
  seeded = await seedFixture({ api, worker }, fixture);
  await seedPlanning({ api, worker }, seeded, fixture);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("planPlanningSeed", () => {
  it("maps 18 bills page items plus 8 renewal-only items, linking r-car to car insurance", () => {
    const plan = planPlanningSeed(fixture);
    expect(plan.items).toHaveLength(26);
    expect(plan.items.filter((i) => !i.onBillsPage).map((i) => i.fixtureId)).toEqual([
      "r-health",
      "r-renters",
      "r-moto",
      "r-life",
      "r-av",
      "r-shop",
      "r-club",
      "r-reg",
    ]);
    expect(plan.items.find((i) => i.fixtureId === "r-car")).toBeUndefined();
    const carins = plan.items.find((i) => i.fixtureId === "b-carins");
    expect(carins?.renewal).toMatchObject({ autoRenews: "yes", coverageEnd: "2026-11-04" });
  });

  it("rejects a fixture whose money is not integer cents", () => {
    const bad = structuredClone(fixture) as { bills: { amountCents: number }[] };
    bad.bills[0]!.amountCents = 1.5;
    expect(() => planPlanningSeed(bad)).toThrow(/amountCents/);
  });
});

describe("seeded fixture (acceptance)", () => {
  it("is idempotent", async () => {
    expect((await seedPlanning({ api, worker }, seeded, fixture)).created).toBe(false);
  });

  it("stores every renewal as an item; renewal-only ones are off the bills page (Q-020)", async () => {
    const rows = await asCreator((tx) =>
      tx.execute<{ id: string; on_bills_page: boolean; paid_from: string; has_renewal: boolean }>(
        sql`select i.id, i.on_bills_page, i.paid_from, (r.item_id is not null) as has_renewal
          from recurring_items i left join renewal_details r on r.item_id = i.id
          where i.household_id = ${seeded.householdId} order by i.id`,
      ),
    );
    expect(rows.rows).toHaveLength(26);
    const off = rows.rows.filter((r) => !r.on_bills_page).map((r) => r.id);
    expect(off.sort()).toEqual(
      ["r-health", "r-renters", "r-moto", "r-life", "r-av", "r-shop", "r-club", "r-reg"].map(fx).sort(),
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(fx("r-health"))?.paid_from).toBe("payroll");
    // r-car is the car insurance item: it carries the renewal details, and there is no separate r-car item.
    expect(byId.get(fx("b-carins"))?.has_renewal).toBe(true);
    expect(byId.has(fx("r-car"))).toBe(false);
    expect(rows.rows.filter((r) => r.has_renewal)).toHaveLength(10); // 9 renewals + the streaming price change
  });

  it("marks the emergency fund goal and points the household at its primary income", async () => {
    const goals = await asCreator((tx) =>
      tx.execute<{ id: string; is_emergency_fund: boolean }>(
        sql`select id, is_emergency_fund from goals where household_id = ${seeded.householdId} order by id`,
      ),
    );
    expect(goals.rows).toHaveLength(3);
    expect(goals.rows.filter((g) => g.is_emergency_fund).map((g) => g.id)).toEqual([fx("g-emergency")]);
    const hh = await asCreator((tx) =>
      tx.execute<{ primary_income_item_id: string }>(
        sql`select primary_income_item_id from households where id = ${seeded.householdId}`,
      ),
    );
    expect(hh.rows[0]?.primary_income_item_id).toBe(fx("inc-sam"));
  });

  it("November occurrences match the calendar: 16 bills and 3 paychecks on the right dates", async () => {
    const rows = await asCreator((tx) =>
      tx.execute<{ item_id: string; due_on: string; direction: string }>(
        sql`select o.item_id, o.due_on::text as due_on, i.direction
          from occurrences o join recurring_items i on i.id = o.item_id
          where o.household_id = ${seeded.householdId} and o.due_on between '2026-11-01' and '2026-11-30'`,
      ),
    );
    const day = (r: { due_on: string }) => Number(r.due_on.slice(8));
    const bills = rows.rows.filter((r) => r.direction === "outflow");
    const paychecks = rows.rows.filter((r) => r.direction === "inflow");
    expect(bills).toHaveLength(16);
    expect(paychecks).toHaveLength(3);
    expect(paychecks.map((r) => `${r.item_id === fx("inc-sam") ? "sam" : "jordan"}${day(r)}`).sort()).toEqual(
      ["jordan27", "sam20", "sam6"],
    );
    const dueDay = (id: string) => bills.find((r) => r.item_id === fx(id));
    expect(
      Object.fromEntries(
        ["b-rent", "b-daycare", "b-power", "b-carins", "b-water", "b-car", "b-phone"].map((id) => [
          id,
          dueDay(id)?.due_on,
        ]),
      ),
    ).toEqual({
      "b-rent": "2026-11-01",
      "b-daycare": "2026-11-02",
      "b-power": "2026-11-03",
      "b-carins": "2026-11-04",
      "b-water": "2026-11-18",
      "b-car": "2026-11-29",
      "b-phone": "2026-11-30",
    });
    // Every item that is due in November appears once.
    expect(new Set(bills.map((r) => r.item_id)).size).toBe(16);
  });

  it("keeps the window to 35 days back and 400 days ahead; the past is history, not to-dos", async () => {
    const range = await asCreator((tx) =>
      tx.execute<{ lo: string; hi: string; overdue: string }>(
        sql`select min(scheduled_on)::text as lo, max(scheduled_on)::text as hi,
            count(*) filter (where status = 'scheduled' and due_on <= '2026-10-27')::text as overdue
          from occurrences where household_id = ${seeded.householdId}`,
      ),
    );
    const { lo = "", hi = "" } = range.rows[0] ?? {};
    expect(lo >= "2026-09-22" && lo <= "2026-09-30").toBe(true);
    expect(hi >= "2027-11-01" && hi <= "2027-12-01").toBe(true);
    expect(range.rows[0]?.overdue).toBe("0");
  });

  it("gives the engine the bills page figures from stored rows: 18 rows and $4,956.94 a month", async () => {
    const rows = await asCreator((tx) =>
      tx.execute<Record<string, unknown>>(
        sql`select id, name, direction, kind, owner_user_id, amount_type, amount_cents, rrule, dtstart::text as dtstart,
              until::text as until, weekend_rule, status, paid_from, on_bills_page
            from recurring_items where household_id = ${seeded.householdId} and deleted_at is null`,
      ),
    );
    const history = await asCreator((tx) =>
      tx.execute<{ item_id: string; amount_cents: string }>(
        sql`select item_id, amount_cents::text from item_amount_history
          where household_id = ${seeded.householdId} and source = 'email' order by item_id, occurred_on`,
      ),
    );
    const items: ItemInput[] = rows.rows.map((r) => {
      const hist = history.rows.filter((h) => h.item_id === r.id).map((h) => Number(h.amount_cents));
      const amountType = r.amount_type as string;
      return {
        id: r.id as string,
        name: r.name as string,
        direction: r.direction as ItemInput["direction"],
        kind: r.kind as ItemKind,
        owner: r.owner_user_id as string,
        amount:
          amountType === "fixed"
            ? { type: "fixed", cents: Number(r.amount_cents) }
            : amountType === "estimated"
              ? { type: "estimated", historyCents: hist }
              : { type: "statement", lastStatementCents: Number(r.amount_cents) },
        schedule: scheduleFromRRule({
          rrule: r.rrule as string,
          dtstart: r.dtstart as string,
          until: r.until as string | null,
        }),
        weekendRule: r.weekend_rule as ItemInput["weekendRule"],
        paidFrom: r.paid_from as ItemInput["paidFrom"],
        status: r.status as ItemInput["status"],
        onBillsPage: r.on_bills_page as boolean,
      };
    });
    const avg = billsAverages({ items } as never);
    expect(avg.rows).toBe(18);
    expect(avg.monthlyBillsAverageCents).toBe(495694);
    expect(avg.monthlyIncomeAverageCents).toBe(972500);
    expect(avg.estimatesToConfirm).toBe(2);
  });
});

describe("materializer", () => {
  async function newItem(rrule: string, dtstart: string, weekendRule = "none"): Promise<string> {
    return asCreator(async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`insert into recurring_items
          (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, weekend_rule,
           owner_type, source, created_by)
        values (${seeded.householdId}, 'outflow', 'bill', 'other', 'Test bill', 'fixed', 1000, ${rrule},
          ${dtstart}::date, ${weekendRule}, 'both', 'manual', ${seeded.userIds.creator}) returning id`);
      return res.rows[0]?.id ?? "";
    });
  }
  const dates = (itemId: string) =>
    asCreator(
      async (tx) =>
        (
          await tx.execute<{ s: string; d: string; status: string }>(
            sql`select scheduled_on::text s, due_on::text d, status from occurrences where item_id = ${itemId} order by scheduled_on`,
          )
        ).rows,
    );

  it("planOccurrences applies the weekend rule to due_on and keeps scheduled_on", () => {
    const planned = planOccurrences(
      {
        id: "x",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        dtstart: "2026-01-01",
        until: null,
        weekendRule: "next_business_day",
        materialize: true,
      },
      "2026-10-27",
      0,
    );
    // Nov 1 2026 is a Sunday.
    expect(planned[0]).toEqual({ scheduledOn: "2026-11-01", dueOn: "2026-11-02" });
    expect(
      planOccurrences(
        {
          id: "x",
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
          dtstart: "2026-01-01",
          until: null,
          weekendRule: "none",
          materialize: false,
        },
        "2026-10-27",
      ),
    ).toEqual([]);
  });

  it("extend is idempotent and fills only what is missing", async () => {
    const id = await newItem("FREQ=MONTHLY;BYMONTHDAY=15", "2026-01-15");
    const first = await asCreator((tx) => extendOccurrences(tx, id, TODAY));
    expect(first.inserted).toBeGreaterThan(12);
    expect((await asCreator((tx) => extendOccurrences(tx, id, TODAY))).inserted).toBe(0);
    // A later "today" adds only the new tail.
    expect((await asCreator((tx) => extendOccurrences(tx, id, "2026-11-27"))).inserted).toBe(1);
    // The nightly household sweep, run as the worker, changes nothing more at the same date.
    const sweep = () =>
      worker.withJobTx(seeded.householdId, (tx) =>
        materializeHousehold(tx, seeded.householdId, "2026-11-27"),
      );
    expect((await sweep()).inserted).toBeGreaterThan(0); // the horizon moved a month for the other items
    expect((await sweep()).inserted).toBe(0);
  });

  it("a schedule change rebuilds only future scheduled occurrences; paid and past ones are untouched", async () => {
    const id = await newItem("FREQ=MONTHLY;BYMONTHDAY=15", "2026-01-15");
    await asCreator((tx) => extendOccurrences(tx, id, TODAY));
    await asCreator((tx) =>
      tx.execute(
        sql`update occurrences set status = 'paid', paid_on = due_on where item_id = ${id} and scheduled_on = '2026-11-15'`,
      ),
    );
    await asCreator((tx) =>
      tx.execute(sql`update recurring_items set rrule = 'FREQ=MONTHLY;BYMONTHDAY=20' where id = ${id}`),
    );
    const result = await asCreator((tx) => rebuildFutureOccurrences(tx, id, TODAY));
    expect(result.deleted).toBeGreaterThan(10);
    const rows = await dates(id);
    // Past (Oct 15; Sep 15 is outside the window) stays as scheduled on the 15th; the paid Nov 15 stays; the future is on the 20th.
    expect(rows.filter((r) => r.s < TODAY).map((r) => r.s)).toEqual(["2026-10-15"]);
    expect(rows.find((r) => r.s === "2026-11-15")).toMatchObject({ status: "paid" });
    const future = rows.filter((r) => r.s >= TODAY && r.status === "scheduled");
    expect(future.every((r) => r.s.endsWith("-20"))).toBe(true);
    expect(future[0]?.s).toBe("2026-11-20");
  });

  it("pausing an item removes its future scheduled occurrences and keeps paid ones", async () => {
    const id = await newItem("FREQ=MONTHLY;BYMONTHDAY=10", "2026-01-10");
    await asCreator((tx) => extendOccurrences(tx, id, TODAY));
    await asCreator((tx) =>
      tx.execute(
        sql`update occurrences set status = 'skipped' where item_id = ${id} and scheduled_on = '2026-12-10'`,
      ),
    );
    await asCreator((tx) => tx.execute(sql`update recurring_items set status = 'paused' where id = ${id}`));
    const result = await asCreator((tx) => rebuildFutureOccurrences(tx, id, TODAY));
    expect(result.inserted).toBe(0);
    const rows = await dates(id);
    expect(rows.filter((r) => r.s >= TODAY).map((r) => r.s)).toEqual(["2026-12-10"]);
  });

  it("the job body derives today from the household timezone and rebuilds one item as the worker", async () => {
    const id = await newItem("FREQ=MONTHLY;BYMONTHDAY=8", "2026-01-08");
    // 2026-10-28T02:30Z is still Oct 27 in New York.
    const job = (rebuild: boolean) =>
      worker.withJobTx(seeded.householdId, (tx) =>
        materializeForJob(
          tx,
          { householdId: seeded.householdId, itemId: id, rebuild },
          "2026-10-28T02:30:00Z",
        ),
      );
    expect((await job(false)).inserted).toBeGreaterThan(12);
    const firstDates = (await dates(id)).map((r) => r.s);
    expect(firstDates[0]).toBe("2026-10-08");
    const rebuilt = await job(true);
    expect(rebuilt.deleted).toBeGreaterThan(0);
    expect((await dates(id)).map((r) => r.s)).toEqual(firstDates);
  });
});

describe("Q-053: a rebuild keeps moved or actual-amount rows whose date is still in the schedule", () => {
  async function item(rrule: string, dtstart: string, weekendRule = "none"): Promise<string> {
    return asCreator(async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`insert into recurring_items
          (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, weekend_rule,
           owner_type, source, created_by)
        values (${seeded.householdId}, 'outflow', 'bill', 'other', 'Keep test', 'fixed', 1000, ${rrule},
          ${dtstart}::date, ${weekendRule}, 'both', 'manual', ${seeded.userIds.creator}) returning id`);
      return res.rows[0]?.id ?? "";
    });
  }
  const rows = (id: string) =>
    asCreator(
      async (tx) =>
        (
          await tx.execute<{ s: string; d: string; moved: boolean; actual: string | null }>(
            sql`select scheduled_on::text s, due_on::text d, (moved_by is not null) moved, actual_amount_cents::text actual
            from occurrences where item_id = ${id} and scheduled_on >= '2026-10-27' order by scheduled_on limit 4`,
          )
        ).rows,
    );

  it("keeps a moved row and an actual-amount row when their date survives, and drops them when it does not", async () => {
    const id = await item("FREQ=MONTHLY;BYMONTHDAY=15", "2026-01-15");
    await asCreator((tx) => extendOccurrences(tx, id, TODAY));
    await asCreator((tx) =>
      tx.execute(sql`update occurrences set due_on = '2026-11-17', moved_by = ${seeded.userIds.creator}
        where item_id = ${id} and scheduled_on = '2026-11-15'`),
    );
    await asCreator((tx) =>
      tx.execute(
        sql`update occurrences set actual_amount_cents = 1234 where item_id = ${id} and scheduled_on = '2026-12-15'`,
      ),
    );
    // A weekday-only edit: the dates stay, so both rows survive; the untouched row takes the new weekend-rule date.
    await asCreator((tx) =>
      tx.execute(sql`update recurring_items set weekend_rule = 'next_business_day' where id = ${id}`),
    );
    const kept = await asCreator((tx) => rebuildFutureOccurrences(tx, id, TODAY));
    expect(kept.deleted).toBeGreaterThan(0);
    const after = await rows(id);
    expect(after[0]).toMatchObject({ s: "2026-11-15", d: "2026-11-17", moved: true }); // moved by hand: kept as is
    expect(after[1]).toMatchObject({ s: "2026-12-15", actual: "1234", d: "2026-12-15" }); // Tue: unchanged
    // Now the day changes: no old date is in the new schedule, so nothing is kept.
    await asCreator((tx) =>
      tx.execute(sql`update recurring_items set rrule = 'FREQ=MONTHLY;BYMONTHDAY=20' where id = ${id}`),
    );
    await asCreator((tx) => rebuildFutureOccurrences(tx, id, TODAY));
    const moved = await rows(id);
    expect(moved.every((r) => r.s.endsWith("-20") && !r.moved && r.actual === null)).toBe(true);
  });
});
