import { EngineError } from "./errors";
import { billsBeforePayday, computePlan, projectRunway } from "./plan";
import { riveraInput } from "./testing";
import type { EngineInput, ItemInput, OccurrenceInput, PlanResult } from "./types";
import { ENGINE_VERSION } from "./version";
import { planningWindow } from "./window";

// A small household: payday every other Friday from Fri Nov 6 2026, today Tue Oct 27.
const pay: ItemInput = {
  id: "pay",
  name: "Pay",
  direction: "inflow",
  kind: "income",
  owner: "m-a",
  amount: { type: "fixed", cents: 300000 },
  schedule: { type: "every_n_weeks", n: 2, dtstart: "2026-10-23" },
};

function bill(id: string, day: number, cents: number, extra: Partial<ItemInput> = {}): ItemInput {
  return {
    id,
    name: id,
    direction: "outflow",
    kind: "bill",
    owner: "m-a",
    amount: { type: "fixed", cents },
    schedule: { type: "monthly_day", day, dtstart: "2026-01-01" },
    ...extra,
  };
}

function household(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    asOf: "2026-10-27",
    timezone: "America/Los_Angeles",
    cushionCents: 50000,
    startingBalance: { cents: 200000, asOf: "2026-10-27" },
    primaryIncomeItemId: "pay",
    items: [pay],
    occurrences: [],
    plannedExpenses: [],
    goals: [],
    ...overrides,
  };
}

const endOf = (plan: PlanResult, date: string) => plan.runway.find((d) => d.date === date)?.endBalanceCents;

describe("planningWindow (rule 1)", () => {
  it("runs from today through the next primary payday, inclusive", () => {
    expect(planningWindow(household())).toEqual({ from: "2026-10-27", to: "2026-11-06", daysToPayday: 10 });
    expect(computePlan(household()).runway.map((d) => d.date)).toHaveLength(11);
  });

  it("on payday, runs to the following payday (Q-007)", () => {
    const plan = computePlan(
      household({ asOf: "2026-11-06", startingBalance: { cents: 1000, asOf: "2026-11-06" } }),
    );
    expect(plan.window).toEqual({ from: "2026-11-06", to: "2026-11-20", daysToPayday: 14 });
    expect(plan.runway).toHaveLength(15);
    // Today's pay is still scheduled, so it counts on the first day.
    expect(plan.lowest).toEqual({ date: "2026-11-06", balanceCents: 301000 });
    expect(plan.safeToSpendCents).toBe(251000);
    expect(plan.perDayCents).toBe(17500);
  });

  it("on payday, pay received on the balance date is already in the balance (Q-006)", () => {
    const plan = computePlan(
      household({
        asOf: "2026-11-06",
        startingBalance: { cents: 301000, asOf: "2026-11-06" },
        occurrences: [{ itemId: "pay", scheduledOn: "2026-11-06", status: "received", paidOn: "2026-11-06" }],
      }),
    );
    expect(plan.window.to).toBe("2026-11-20");
    expect(plan.runway[0]).toMatchObject({ date: "2026-11-06", endBalanceCents: 301000, events: [] });
  });

  it("skips a skipped payday and follows a moved one", () => {
    const skipped: OccurrenceInput = { itemId: "pay", scheduledOn: "2026-11-06", status: "skipped" };
    expect(planningWindow(household({ occurrences: [skipped] })).to).toBe("2026-11-20");
    const moved: OccurrenceInput = { itemId: "pay", scheduledOn: "2026-11-06", dueOn: "2026-11-05" };
    expect(planningWindow(household({ occurrences: [moved] })).to).toBe("2026-11-05");
  });

  it("applies the primary income's weekend rule", () => {
    // The 15th of November 2026 is a Sunday.
    const monthly: ItemInput = {
      ...pay,
      schedule: { type: "monthly_day", day: 15, dtstart: "2026-01-01" },
      weekendRule: "prev_business_day",
    };
    expect(
      planningWindow(
        household({
          asOf: "2026-11-01",
          startingBalance: { cents: 0, asOf: "2026-11-01" },
          items: [monthly],
        }),
      ).to,
    ).toBe("2026-11-13");
  });

  it("fails when there is no primary payday ahead", () => {
    const ended: ItemInput = { ...pay, schedule: { ...pay.schedule, until: "2026-10-23" } };
    expect(() => planningWindow(household({ items: [ended] }))).toThrow(EngineError);
  });
});

describe("projectRunway (rule 2)", () => {
  it("applies each day's income, bills and planned expenses", () => {
    const plan = computePlan(
      household({
        items: [pay, bill("rent", 1, 150000), bill("phone", 31, 5000, { weekendRule: "next_business_day" })],
        plannedExpenses: [
          { id: "gift", name: "Gift", owner: "both", amountCents: 2500, dueOn: "2026-10-28" },
        ],
      }),
    );
    expect(endOf(plan, "2026-10-27")).toBe(200000);
    expect(endOf(plan, "2026-10-28")).toBe(197500);
    // Phone on Sat Oct 31 moves to Mon Nov 2; rent on Sun Nov 1 has no weekend rule.
    expect(endOf(plan, "2026-10-31")).toBe(197500);
    expect(endOf(plan, "2026-11-01")).toBe(47500);
    expect(endOf(plan, "2026-11-02")).toBe(42500);
    expect(endOf(plan, "2026-11-06")).toBe(342500);
    expect(
      plan.runway.find((d) => d.date === "2026-11-02")?.events.map((e) => [e.sourceId, e.scheduledOn]),
    ).toEqual([["phone", "2026-10-31"]]);
  });

  it("uses the actual amount, else the mean of the last 3 amounts (half up), else the statement", () => {
    const power = bill("power", 3, 0, {
      amount: { type: "estimated", historyCents: [99999, 10000, 10001, 10001] },
    });
    const card = bill("card", 4, 0, { amount: { type: "statement", lastStatementCents: 64000 } });
    const plan = computePlan(household({ items: [pay, power, card] }));
    const events = plan.runway.flatMap((d) => d.events).filter((e) => e.kind === "bill");
    expect(events.map((e) => [e.sourceId, e.amountCents, e.isEstimate])).toEqual([
      ["power", -10001, true],
      ["card", -64000, true],
    ]);
    const actual = computePlan(
      household({
        items: [pay, power],
        occurrences: [{ itemId: "power", scheduledOn: "2026-11-03", actualAmountCents: 12345 }],
      }),
    );
    expect(actual.runway.flatMap((d) => d.events).find((e) => e.sourceId === "power")).toMatchObject({
      amountCents: -12345,
      isEstimate: false,
    });
  });

  it("drops occurrences moved out of the window and adds ones moved in", () => {
    const items = [pay, bill("rent", 1, 150000), bill("later", 20, 1000)];
    const occurrences: OccurrenceInput[] = [
      { itemId: "rent", scheduledOn: "2026-11-01", dueOn: "2026-11-09" },
      { itemId: "later", scheduledOn: "2026-11-20", dueOn: "2026-11-05" },
    ];
    const plan = computePlan(household({ items, occurrences }));
    expect(plan.runway.flatMap((d) => d.events).map((e) => [e.sourceId, e.date])).toEqual([
      ["later", "2026-11-05"],
      ["pay", "2026-11-06"],
    ]);
  });

  it("leaves out payroll deductions, inactive items and non-planned planned expenses", () => {
    const plan = computePlan(
      household({
        items: [
          pay,
          bill("health", 2, 24800, { paidFrom: "payroll" }),
          bill("paused", 3, 1000, { status: "paused" }),
        ],
        plannedExpenses: [
          { id: "done", name: "Done", owner: "both", amountCents: 100, dueOn: "2026-10-29", status: "done" },
          {
            id: "cancelled",
            name: "No",
            owner: "both",
            amountCents: 100,
            dueOn: "2026-10-29",
            status: "cancelled",
          },
        ],
      }),
    );
    expect(plan.runway.flatMap((d) => d.events).map((e) => e.sourceId)).toEqual(["pay"]);
    expect(plan.billsBeforePayday.count).toBe(0);
  });

  it("paused and ended items project no scheduled rows, but their paid rows still count", () => {
    const input = household({
      startingBalance: { cents: 200000, asOf: "2026-10-26" },
      items: [
        pay,
        bill("paused", 3, 1000, { status: "paused" }),
        bill("ended", 28, 2000, { status: "ended" }),
      ],
      occurrences: [
        // A materialized future row left behind when the item was paused.
        { itemId: "paused", scheduledOn: "2026-11-03" },
        // Paid after the balance date: the money already left, so it still counts (rule 7).
        { itemId: "ended", scheduledOn: "2026-10-28", status: "paid", paidOn: "2026-10-27" },
      ],
    });
    const plan = computePlan(input);
    expect(plan.runway.flatMap((d) => d.events).map((e) => [e.sourceId, e.date])).toEqual([
      ["ended", "2026-10-27"],
      ["pay", "2026-11-06"],
    ]);
    expect(plan.billsBeforePayday).toEqual({ count: 1, totalCents: 2000, byOwner: { "m-a": 2000 } });
  });

  it("schedules goal deposits on the first primary payday of the month and leaves the final payday's to the next window", () => {
    const plan = computePlan(
      household({
        goals: [
          { id: "save", name: "Save", targetCents: 100000, savedCents: 0, monthlyCents: 10000 },
          { id: "done", name: "Done", targetCents: 100, savedCents: 100, monthlyCents: 10000 },
          {
            id: "gift",
            name: "Gift",
            type: "planned_expense",
            targetCents: 100,
            savedCents: 0,
            monthlyCents: 50,
          },
        ],
      }),
    );
    expect(plan.runwayDetail.excludedEvents.map((e) => [e.sourceId, e.date, e.amountCents])).toEqual([
      ["save", "2026-11-06", -10000],
    ]);
    expect(endOf(plan, "2026-11-06")).toBe(500000);
  });
});

describe("paid occurrences and an older balance (rule 7, Q-006)", () => {
  // Balance from Tue Oct 20; today Tue Oct 27.
  const base = (occurrences: OccurrenceInput[], items: ItemInput[] = [pay, bill("b", 22, 1000)]) =>
    projectRunway(household({ startingBalance: { cents: 200000, asOf: "2026-10-20" }, items, occurrences }));

  it("applies unpaid occurrences between the balance date and today before the first day", () => {
    const r = base([]);
    expect(r.carriedEvents.map((e) => [e.sourceId, e.date])).toEqual([
      ["b", "2026-10-22"],
      ["pay", "2026-10-23"],
    ]);
    expect(r.openingBalanceCents).toBe(200000 - 1000 + 300000);
    expect(r.days[0]?.endBalanceCents).toBe(r.openingBalanceCents);
  });

  it("counts a bill paid after the balance date, on its paid date", () => {
    const r = base([{ itemId: "b", scheduledOn: "2026-10-22", status: "paid", paidOn: "2026-10-21" }]);
    expect(r.carriedEvents.find((e) => e.sourceId === "b")?.date).toBe("2026-10-21");
  });

  it("does not count a bill paid on or before the balance date", () => {
    for (const paidOn of ["2026-10-19", "2026-10-20"]) {
      const r = base([{ itemId: "b", scheduledOn: "2026-10-22", status: "paid", paidOn }]);
      expect(r.carriedEvents.map((e) => e.sourceId)).toEqual(["pay"]);
    }
  });

  it("moves a bill paid early to its paid date", () => {
    const items = [pay, bill("b", 2, 1000)];
    const early = base(
      [{ itemId: "b", scheduledOn: "2026-11-02", status: "paid", paidOn: "2026-10-25" }],
      items,
    );
    expect(early.carriedEvents.map((e) => [e.sourceId, e.date, e.dueOn])).toContainEqual([
      "b",
      "2026-10-25",
      "2026-11-02",
    ]);
    expect(early.days.flatMap((d) => d.events).map((e) => e.sourceId)).toEqual(["pay"]);
  });

  it("counts a scheduled bill due on the balance date, not one due before it", () => {
    const onDate = base([], [pay, bill("b", 20, 1000)]);
    expect(onDate.carriedEvents.map((e) => e.sourceId)).toContain("b");
    const before = base([], [pay, bill("b", 19, 1000)]);
    expect(before.carriedEvents.map((e) => e.sourceId)).not.toContain("b");
  });

  it("never counts a skipped occurrence", () => {
    const r = base([{ itemId: "b", scheduledOn: "2026-10-22", status: "skipped" }]);
    expect(r.carriedEvents.map((e) => e.sourceId)).toEqual(["pay"]);
  });

  it("treats received income like paid bills", () => {
    const r = base([{ itemId: "pay", scheduledOn: "2026-10-23", status: "received", paidOn: "2026-10-20" }]);
    expect(r.carriedEvents.map((e) => e.sourceId)).toEqual(["b"]);
  });

  it("raises stale_balance when the balance is more than 7 days old", () => {
    const at = (asOf: string) => computePlan(household({ startingBalance: { cents: 0, asOf } })).flags;
    expect(at("2026-10-20")).toEqual([]);
    expect(at("2026-10-19")).toEqual([{ code: "stale_balance", subjectId: null, date: "2026-10-19" }]);
  });
});

describe("billsBeforePayday", () => {
  const items = [
    pay,
    bill("a", 28, 1000),
    bill("b", 29, 2000, { owner: "both" }),
    bill("c", 6, 4000),
    bill("d", 30, 8000),
  ];

  it("counts money out due from today up to, not on, payday, by owner", () => {
    const r = billsBeforePayday(
      household({
        items,
        occurrences: [
          { itemId: "a", scheduledOn: "2026-10-28", status: "paid", paidOn: "2026-10-26" },
          { itemId: "d", scheduledOn: "2026-10-30", status: "skipped" },
        ],
        plannedExpenses: [{ id: "p", name: "P", owner: "m-b", amountCents: 16000, dueOn: "2026-11-05" }],
      }),
    );
    // c is due on payday (Nov 6): not before payday. d is skipped. The paid bill is still listed.
    expect(r).toEqual({ count: 3, totalCents: 19000, byOwner: { "m-a": 1000, both: 2000, "m-b": 16000 } });
  });

  it("on payday, counts bills from today up to the following payday", () => {
    expect(
      billsBeforePayday(
        household({ asOf: "2026-11-06", startingBalance: { cents: 0, asOf: "2026-11-06" }, items }),
      ),
    ).toEqual({ count: 1, totalCents: 4000, byOwner: { "m-a": 4000 } });
  });
});

describe("computePlan", () => {
  it("stamps the engine version and is deterministic", () => {
    const a = computePlan(riveraInput());
    expect(a.engineVersion).toBe(ENGINE_VERSION);
    expect(computePlan(riveraInput())).toEqual(a);
  });

  it("does not mutate its input", () => {
    const input = riveraInput({ scenario: "shortfall" });
    const snapshot = JSON.parse(JSON.stringify(input)) as EngineInput;
    computePlan(input);
    expect(input).toEqual(snapshot);
  });

  it("math lines add up: start + carried + income − out = lowest; lowest − cushion = safe", () => {
    for (const input of [
      riveraInput(),
      riveraInput({ scenario: "shortfall" }),
      household({ startingBalance: { cents: 1000, asOf: "2026-10-15" }, items: [pay, bill("x", 20, 700)] }),
    ]) {
      const plan = computePlan(input);
      const v = (id: string) => plan.math.find((l) => l.id === id);
      const lowest =
        (v("starting_balance")?.cents ?? 0) +
        (v("carried_events")?.cents ?? 0) +
        (v("income_in_window")?.cents ?? 0) -
        (v("money_out_in_window")?.cents ?? 0);
      expect(v("lowest_point")).toMatchObject({ cents: lowest, date: plan.lowest.date });
      expect(lowest).toBe(plan.lowest.balanceCents);
      const gap = v("shortfall")?.cents;
      const safe = gap !== undefined && gap !== null ? -gap : v("safe_to_spend")?.cents;
      expect(lowest - (v("cushion")?.cents ?? 0)).toBe(safe);
      expect(v("days_to_payday")?.days).toBe(plan.window.daysToPayday);
    }
  });

  it("rivera math lines", () => {
    expect(computePlan(riveraInput()).math.map((l) => [l.id, l.role, l.cents ?? l.days, l.date])).toEqual([
      ["starting_balance", "value", 340000, "2026-10-27"],
      ["income_in_window", "value", 290000, null],
      ["money_out_in_window", "subtract", 479299, null],
      ["lowest_point", "value", 150701, "2026-11-05"],
      ["cushion", "subtract", 50000, null],
      ["safe_to_spend", "total", 100701, null],
      ["days_to_payday", "value", 10, "2026-11-06"],
      ["per_day", "value", 10000, null],
    ]);
  });
});

describe("input validation", () => {
  const cases: [string, Partial<EngineInput>][] = [
    ["a balance dated after today", { startingBalance: { cents: 0, asOf: "2026-10-28" } }],
    ["fractional cents", { startingBalance: { cents: 10.5, asOf: "2026-10-27" } }],
    ["a negative cushion", { cushionCents: -1 }],
    ["an unknown timezone", { timezone: "Mars/Olympus" }],
    ["a bad date", { asOf: "2026-13-01" }],
    [
      "a primary income that is not income",
      { primaryIncomeItemId: "rent", items: [pay, bill("rent", 1, 1)] },
    ],
    ["an occurrence for an unknown item", { occurrences: [{ itemId: "nope", scheduledOn: "2026-11-01" }] }],
    [
      "duplicate occurrences",
      {
        occurrences: [
          { itemId: "pay", scheduledOn: "2026-11-06" },
          { itemId: "pay", scheduledOn: "2026-11-06" },
        ],
      },
    ],
    ["duplicate items", { items: [pay, pay] }],
    [
      "an estimate without history",
      { items: [pay, bill("x", 1, 0, { amount: { type: "estimated", historyCents: [] } })] },
    ],
    ["a negative amount", { items: [pay, bill("x", 1, -5)] }],
  ];

  it.each(cases)("rejects %s", (_name, overrides) => {
    expect(() => computePlan(household(overrides))).toThrow(EngineError);
  });
});
