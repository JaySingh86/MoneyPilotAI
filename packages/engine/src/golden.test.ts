// Golden test (ADR-005): the Rivera household must produce every core value under `expected`
// (WORK_PLAN WP-02: planningWindow, runwayEndOfDayCents, lowest, safeToSpend*, perDayDisplay,
// billsBeforePayday) and the core values of `scenarios.shortfall.expected`.
import { computePlan } from "./plan";
import { riveraFixture, riveraInput } from "./testing";
import type { PlanResult } from "./types";

const expected = riveraFixture.expected;
const shortfall = riveraFixture.scenarios.shortfall.expected;

/** Whole dollars with thousands separators, matching the fixture's display strings. Test-only. */
function wholeDollars(cents: number): string {
  if (cents % 100 !== 0) throw new Error("not whole dollars");
  return `$${String(Math.abs(cents) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function endOfDay(plan: PlanResult): Record<string, number> {
  return Object.fromEntries(plan.runway.map((d) => [d.date, d.endBalanceCents]));
}

describe("golden: Rivera household (expected)", () => {
  const plan = computePlan(riveraInput());

  it("planningWindow", () => {
    expect(plan.window).toEqual(expected.planningWindow);
  });

  it("runwayEndOfDayCents", () => {
    expect(endOfDay(plan)).toEqual(expected.runwayEndOfDayCents);
  });

  it("lowest", () => {
    expect(plan.lowest).toEqual(expected.lowest);
  });

  it("safeToSpendCents and safeToSpendDisplay", () => {
    expect(plan.state).toBe("on_track");
    expect(plan.safeToSpendCents).toBe(expected.safeToSpendCents);
    expect(plan.shortfallDisplayCents).toBeNull();
    expect(plan.safeToSpendDisplayCents).not.toBeNull();
    expect(wholeDollars(plan.safeToSpendDisplayCents ?? Number.NaN)).toBe(expected.safeToSpendDisplay);
  });

  it("perDayDisplay", () => {
    expect(plan.perDayCents).not.toBeNull();
    expect(`≈ ${wholeDollars(plan.perDayCents ?? Number.NaN)} a day`).toBe(expected.perDayDisplay);
  });

  it("billsBeforePayday", () => {
    expect(plan.billsBeforePayday).toEqual(expected.billsBeforePayday);
  });

  it("safeToSpendIfCarInsuranceMovedToPaydayCents", () => {
    const moved = computePlan(
      riveraInput({ occurrences: [{ itemId: "b-carins", scheduledOn: "2026-11-04", dueOn: "2026-11-06" }] }),
    );
    expect(moved.safeToSpendCents).toBe(expected.safeToSpendIfCarInsuranceMovedToPaydayCents);
  });

  it("safeToSpendAfterElectricityActual15137Cents", () => {
    const actual = computePlan(
      riveraInput({
        occurrences: [{ itemId: "b-power", scheduledOn: "2026-11-03", actualAmountCents: 15137 }],
      }),
    );
    expect(actual.safeToSpendCents).toBe(expected.safeToSpendAfterElectricityActual15137Cents);
  });

  it("is on track with nothing below the cushion and a fresh balance", () => {
    expect(plan.belowCushionFrom).toBeNull();
    expect(plan.belowZeroDates).toEqual([]);
    expect(plan.flags).toEqual([]);
  });

  it("leaves the payday goal transfers to the next window", () => {
    expect(plan.runwayDetail.excludedEvents.map((e) => [e.sourceId, e.date, e.amountCents])).toEqual([
      ["g-emergency", "2026-11-06", -30000],
      ["g-tahoe", "2026-11-06", -25000],
    ]);
  });
});

describe("golden: Rivera household (scenarios.shortfall.expected, core values)", () => {
  const plan = computePlan(riveraInput({ scenario: "shortfall" }));

  it("runwayEndOfDayCents", () => {
    expect(endOfDay(plan)).toEqual(shortfall.runwayEndOfDayCents);
  });

  it("lowest", () => {
    expect(plan.lowest).toEqual(shortfall.lowest);
  });

  it("safeToSpendCents and heroDisplay", () => {
    expect(plan.state).toBe("shortfall");
    expect(plan.safeToSpendCents).toBe(shortfall.safeToSpendCents);
    expect(plan.safeToSpendDisplayCents).toBeNull();
    expect(plan.perDayCents).toBeNull();
    expect(`${wholeDollars(plan.shortfallDisplayCents ?? Number.NaN)} short`).toBe(shortfall.heroDisplay);
  });

  it("belowCushionFrom and belowZeroDates", () => {
    expect(plan.belowCushionFrom).toBe(shortfall.belowCushionFrom);
    expect(plan.belowZeroDates).toEqual(shortfall.belowZeroDates);
  });

  it("itemsBeforePayday", () => {
    expect({ count: plan.billsBeforePayday.count, totalCents: plan.billsBeforePayday.totalCents }).toEqual(
      shortfall.itemsBeforePayday,
    );
  });
});

// Regression (Q-007): on payday the window runs to the following payday. Not fixture keys: derived by
// hand from the fixture's bills (Nov 8 News −8.00, Nov 9 Cloud −2.99, Nov 12 Music −16.99, Nov 15 Card
// −640.00, Nov 17 Fitness −14.99, Nov 18 Water −96.00) and the Nov 6 goal deposits (−300 − 250), which
// fall inside this window because Nov 6 is its first day, not its final payday.
describe("regression: Rivera household on payday (asOf 2026-11-06)", () => {
  const onPayday = {
    ...riveraInput({
      // Internet (due Nov 5) was paid that day, so the end-of-day balance already includes it (Q-006).
      occurrences: [
        { itemId: "b-internet", scheduledOn: "2026-11-05", status: "paid", paidOn: "2026-11-05" },
      ],
    }),
    asOf: "2026-11-06",
    // The fixture's projected end of Nov 5, entered as a fresh end-of-day balance.
    startingBalance: { cents: expected.runwayEndOfDayCents["2026-11-05"] ?? Number.NaN, asOf: "2026-11-05" },
  };
  const plan = computePlan(onPayday);

  it("plans Nov 6 → Nov 20, not a single day", () => {
    expect(plan.window).toEqual({ from: "2026-11-06", to: "2026-11-20", daysToPayday: 14 });
  });

  it("projects the runway, lowest point and safe to spend", () => {
    // prettier-ignore
    expect(endOfDay(plan)).toEqual({
      "2026-11-06": 410701, "2026-11-07": 410701, "2026-11-08": 409901, "2026-11-09": 409602,
      "2026-11-10": 409602, "2026-11-11": 409602, "2026-11-12": 407903, "2026-11-13": 407903,
      "2026-11-14": 407903, "2026-11-15": 343903, "2026-11-16": 343903, "2026-11-17": 342404,
      "2026-11-18": 332804, "2026-11-19": 332804, "2026-11-20": 647804,
    });
    expect(plan.lowest).toEqual({ date: "2026-11-18", balanceCents: 332804 });
    expect(plan.safeToSpendCents).toBe(282804);
    expect(plan.perDayCents).toBe(20000);
    expect(plan.billsBeforePayday).toEqual({
      count: 6,
      totalCents: 77897,
      byOwner: { "m-jordan": 66499, "m-sam": 11398 },
    });
  });

  it("gives the same runway from the fixture's original 10-day-old balance, with a stale flag", () => {
    const fromOldBalance = computePlan({ ...riveraInput(), asOf: "2026-11-06" });
    expect(fromOldBalance.runwayDetail.openingBalanceCents).toBe(expected.runwayEndOfDayCents["2026-11-05"]);
    expect(fromOldBalance.runway).toEqual(plan.runway);
    expect(fromOldBalance.flags.map((f) => f.code)).toEqual(["stale_balance"]);
  });
});
