// Property tests (BACKEND_PLAN §7.2) over seeded random households. Engine tests may use fast-check
// (QUESTIONS.md Q-009); this seeded generator is the accepted alternative and keeps runs reproducible.
import { WEEKDAYS, parseDate } from "./dates";
import { computePlan } from "./plan";
import { forAllSeeds } from "./testing";
import type { Rng } from "./testing";
import type {
  EngineInput,
  ItemInput,
  OccurrenceInput,
  PlanResult,
  PlannedExpenseInput,
  Schedule,
  WeekendRule,
} from "./types";

const RUNS = 300;
const OWNERS = ["m-a", "m-b", "both", "split"];
const RULES: WeekendRule[] = ["none", "none", "prev_business_day", "next_business_day"];

function randomDate(rng: Rng, from: string, maxDays: number): string {
  return parseDate(from)
    .add({ days: rng.int(0, maxDays) })
    .toString();
}

function randomSchedule(rng: Rng, around: string): Schedule {
  const dtstart = parseDate(around)
    .subtract({ days: rng.int(0, 120) })
    .toString();
  switch (rng.int(0, 5)) {
    case 0:
      return { type: "monthly_day", day: rng.int(1, 31), dtstart };
    case 1:
      return { type: "monthly_last_day", dtstart };
    case 2:
      return { type: "monthly_last_weekday", weekday: rng.pick(WEEKDAYS), dtstart };
    case 3:
      return { type: "every_n_weeks", n: rng.int(1, 4), dtstart };
    case 4:
      return { type: "every_n_months", n: rng.int(2, 6), dtstart };
    default:
      return {
        type: "yearly",
        dtstart: parseDate(around)
          .subtract({ days: rng.int(0, 360) })
          .toString(),
      };
  }
}

function randomHousehold(rng: Rng): EngineInput {
  const asOf = randomDate(rng, "2026-01-01", 900);
  const balanceAsOf = parseDate(asOf)
    .subtract({ days: rng.int(0, 10) })
    .toString();
  const primary: ItemInput = {
    id: "primary",
    name: "Primary pay",
    direction: "inflow",
    kind: "income",
    owner: "m-a",
    amount: { type: "fixed", cents: rng.int(100000, 500000) },
    schedule: rng.bool()
      ? {
          type: "every_n_weeks",
          n: rng.int(1, 2),
          dtstart: parseDate(asOf)
            .subtract({ days: rng.int(0, 13) })
            .toString(),
        }
      : randomSchedule(rng, asOf),
    weekendRule: rng.pick(RULES),
  };
  const items: ItemInput[] = [primary];
  const count = rng.int(0, 14);
  for (let i = 0; i < count; i++) {
    const inflow = rng.bool(0.15);
    items.push({
      id: `item-${i}`,
      name: `Item ${i}`,
      direction: inflow ? "inflow" : "outflow",
      kind: inflow ? "income" : "bill",
      owner: rng.pick(OWNERS),
      amount:
        rng.int(0, 4) === 0
          ? { type: "estimated", historyCents: [rng.int(0, 40000), rng.int(0, 40000), rng.int(0, 40000)] }
          : { type: "fixed", cents: rng.int(0, 300000) },
      schedule: randomSchedule(rng, asOf),
      weekendRule: rng.pick(RULES),
      paidFrom: rng.bool(0.05) ? "payroll" : "account",
    });
  }
  const plannedExpenses: PlannedExpenseInput[] = [];
  for (let i = 0, n = rng.int(0, 3); i < n; i++) {
    plannedExpenses.push({
      id: `planned-${i}`,
      name: `Planned ${i}`,
      owner: rng.pick(OWNERS),
      amountCents: rng.int(1, 200000),
      dueOn: parseDate(balanceAsOf)
        .add({ days: rng.int(0, 40) })
        .toString(),
    });
  }
  return {
    asOf,
    timezone: rng.pick(["America/Los_Angeles", "Pacific/Honolulu", "America/New_York"]),
    cushionCents: rng.int(0, 100000),
    startingBalance: { cents: rng.int(-100000, 800000), asOf: balanceAsOf },
    primaryIncomeItemId: "primary",
    items,
    occurrences: [],
    plannedExpenses,
    goals: rng.bool()
      ? [
          {
            id: "goal",
            name: "Goal",
            targetCents: 1000000,
            savedCents: rng.int(0, 900000),
            monthlyCents: rng.int(0, 50000),
          },
        ]
      : [],
  };
}

/** Adds random materialized rows (paid, received, skipped, moved, actual amounts) for the plan's events. */
function withRandomRows(rng: Rng, input: EngineInput): EngineInput {
  const plan = computePlan(input);
  const occurrences: OccurrenceInput[] = [];
  const events = [...plan.runwayDetail.carriedEvents, ...plan.runway.flatMap((d) => d.events)].filter(
    (e) => e.kind === "income" || e.kind === "bill",
  );
  for (const e of events) {
    if (e.sourceId === input.primaryIncomeItemId || !rng.bool(0.3)) continue;
    const roll = rng.int(0, 3);
    occurrences.push({
      itemId: e.sourceId,
      scheduledOn: e.scheduledOn,
      ...(roll === 0
        ? {
            status: e.amountCents > 0 ? "received" : "paid",
            paidOn: randomDate(rng, input.startingBalance.asOf, 3),
          }
        : {}),
      ...(roll === 1 ? { status: "skipped" } : {}),
      ...(roll === 2
        ? {
            dueOn: parseDate(e.dueOn)
              .add({ days: rng.int(-3, 5) })
              .toString(),
          }
        : {}),
      ...(roll === 3 ? { actualAmountCents: rng.int(0, 100000) } : {}),
    });
  }
  return { ...input, occurrences };
}

function households(check: (input: EngineInput, plan: PlanResult, rng: Rng) => void) {
  forAllSeeds(RUNS, (rng) => {
    const input = withRandomRows(rng, randomHousehold(rng));
    check(input, computePlan(input), rng);
  });
}

describe("properties (BACKEND_PLAN §7.2)", () => {
  it("runway balance on day n = start + every event up to day n", () => {
    households((_input, plan) => {
      let running = plan.runwayDetail.startingBalanceCents;
      for (const e of plan.runwayDetail.carriedEvents) running += e.amountCents;
      expect(plan.runwayDetail.openingBalanceCents).toBe(running);
      for (const day of plan.runway) {
        for (const e of day.events) {
          expect(e.date).toBe(day.date);
          running += e.amountCents;
        }
        expect(day.endBalanceCents).toBe(running);
      }
    });
  });

  it("safe to spend ≤ lowest point, and the lowest point is the minimum before payday", () => {
    households((input, plan) => {
      expect(plan.safeToSpendCents).toBeLessThanOrEqual(plan.lowest.balanceCents);
      expect(plan.safeToSpendCents).toBe(plan.lowest.balanceCents - input.cushionCents);
      const beforePayday = plan.runway.length > 1 ? plan.runway.slice(0, -1) : plan.runway;
      expect(Math.min(...beforePayday.map((d) => d.endBalanceCents))).toBe(plan.lowest.balanceCents);
      expect(beforePayday.find((d) => d.endBalanceCents === plan.lowest.balanceCents)?.date).toBe(
        plan.lowest.date,
      );
    });
  });

  it("displayed amounts follow rules 4 and 5", () => {
    households((_input, plan) => {
      if (plan.state === "on_track") {
        expect(plan.safeToSpendCents).toBeGreaterThanOrEqual(0);
        expect(plan.safeToSpendDisplayCents).toBe(plan.safeToSpendCents - (plan.safeToSpendCents % 100));
        if (plan.window.daysToPayday > 0) {
          const perDay = plan.perDayCents ?? Number.NaN;
          expect(perDay % 500).toBe(0);
          expect(perDay * plan.window.daysToPayday).toBeLessThanOrEqual(plan.safeToSpendCents);
          expect((perDay + 500) * plan.window.daysToPayday).toBeGreaterThan(plan.safeToSpendCents);
        }
      } else {
        expect(plan.safeToSpendCents).toBeLessThan(0);
        const short = plan.shortfallDisplayCents ?? Number.NaN;
        expect(short % 100).toBe(0);
        expect(short).toBeGreaterThanOrEqual(-plan.safeToSpendCents);
        expect(short - 100).toBeLessThan(-plan.safeToSpendCents);
        expect(plan.perDayCents).toBeNull();
      }
    });
  });

  it("every amount is a safe integer", () => {
    households((_input, plan) => {
      const amounts = [
        plan.safeToSpendCents,
        plan.lowest.balanceCents,
        plan.billsBeforePayday.totalCents,
        ...Object.values(plan.billsBeforePayday.byOwner),
        ...plan.runway.flatMap((d) => [d.endBalanceCents, ...d.events.map((e) => e.amountCents)]),
        ...plan.math.flatMap((l) => (l.cents === null ? [] : [l.cents])),
      ];
      for (const a of amounts) expect(Number.isSafeInteger(a)).toBe(true);
    });
  });

  it("moving a bill later never lowers the lowest point within the window", () => {
    let moves = 0;
    households((input, plan, rng) => {
      const movable = plan.runway
        .flatMap((d) => d.events)
        .filter((e) => (e.kind === "bill" && e.status === "scheduled") || e.kind === "planned_expense");
      if (movable.length === 0) return;
      const e = rng.pick(movable);
      const later = parseDate(e.dueOn)
        .add({ days: rng.int(1, 20) })
        .toString();
      let moved: EngineInput;
      if (e.kind === "planned_expense") {
        moved = {
          ...input,
          plannedExpenses: input.plannedExpenses.map((p) =>
            p.id === e.sourceId ? { ...p, dueOn: later } : p,
          ),
        };
      } else {
        const rest = input.occurrences.filter(
          (o) => !(o.itemId === e.sourceId && o.scheduledOn === e.scheduledOn),
        );
        const row = input.occurrences.find((o) => o.itemId === e.sourceId && o.scheduledOn === e.scheduledOn);
        moved = {
          ...input,
          occurrences: [...rest, { ...row, itemId: e.sourceId, scheduledOn: e.scheduledOn, dueOn: later }],
        };
      }
      const after = computePlan(moved);
      moves++;
      expect(after.window).toEqual(plan.window);
      expect(after.lowest.balanceCents).toBeGreaterThanOrEqual(plan.lowest.balanceCents);
      expect(after.safeToSpendCents).toBeGreaterThanOrEqual(plan.safeToSpendCents);
    });
    // Guard against a vacuous pass: most generated households must have a bill to move.
    expect(moves).toBeGreaterThan(RUNS / 2);
  });

  it("the generator covers shortfalls, carried events and materialized rows", () => {
    const seen = { shortfall: 0, onTrack: 0, carried: 0, rows: 0 };
    households((input, plan) => {
      seen[plan.state === "shortfall" ? "shortfall" : "onTrack"]++;
      if (plan.runwayDetail.carriedEvents.length > 0) seen.carried++;
      if (input.occurrences.length > 0) seen.rows++;
    });
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(RUNS / 10);
  });
});
