// The mock API serves the golden fixture: every `expected` value the Overview and Calendar show.
import { riveraFixture } from "@mp/engine/testing";
import { describe, expect, it } from "vitest";
import { JORDAN_ID, SAM_ID } from "./identity";
import { buildCalendar, buildPlan, tasksDueBadge } from "./model";

const { expected } = riveraFixture;
const shortfall = riveraFixture.scenarios.shortfall.expected;

describe("GET /plan (on track)", () => {
  const plan = buildPlan("base");

  it("matches the fixture's golden core values", () => {
    expect(plan.state).toBe("on_track");
    expect(plan.safeToSpendCents).toBe(expected.safeToSpendCents);
    expect(plan.safeToSpendDisplayCents).toBe(100700);
    expect(plan.perDayCents).toBe(10000);
    expect(plan.lowest).toEqual(expected.lowest);
    expect(plan.window).toEqual(expected.planningWindow);
    expect(plan.billsBeforePayday.count).toBe(8);
    expect(plan.billsBeforePayday.totalCents).toBe(expected.billsBeforePayday.totalCents);
    expect(plan.billsBeforePayday.byOwner).toEqual({
      [SAM_ID]: expected.billsBeforePayday.byOwner["m-sam"],
      [JORDAN_ID]: expected.billsBeforePayday.byOwner["m-jordan"],
    });
  });

  it("serves the runway end-of-day balances", () => {
    expect(Object.fromEntries(plan.runway.map((d) => [d.date, d.endBalanceCents]))).toEqual(
      expected.runwayEndOfDayCents,
    );
  });

  it("lists exactly the bills due before payday, summing to the golden total", () => {
    expect(plan.dueBeforePayday).toHaveLength(8);
    expect(plan.dueBeforePayday.reduce((sum, r) => sum + r.amountCents, 0)).toBe(
      expected.billsBeforePayday.totalCents,
    );
  });

  it("ranks the three decision cards: car insurance, electricity estimate, Lake Tahoe", () => {
    expect(plan.decisions.map((d) => [d.kind, d.params.name])).toEqual([
      ["not_usual_month", "Car insurance renewal"],
      ["estimate", "Electricity"],
      ["goal_behind", "Lake Tahoe trip"],
    ]);
    expect(plan.decisions[0]?.params.altSafeToSpendCents).toBe(
      expected.safeToSpendIfCarInsuranceMovedToPaydayCents,
    );
  });

  it("serves goals and the tasks badge", () => {
    expect(plan.goals.map((g) => [g.name, g.progress.percent])).toEqual([
      ["Emergency fund", 64],
      ["Lake Tahoe trip", 48],
      ["Holiday gifts", 53],
    ]);
    expect(plan.tasks.dueThisWeek).toHaveLength(expected.tasks.dueThisWeek);
    expect(tasksDueBadge("base")).toBe(expected.tasks.navBadge);
    expect(plan.runwayDetail.excludedEvents.reduce((sum, e) => sum - e.amountCents, 0)).toBe(55000);
  });
});

describe("GET /plan (shortfall)", () => {
  const plan = buildPlan("shortfall");

  it("matches the shortfall scenario's golden values", () => {
    expect(plan.state).toBe("shortfall");
    expect(plan.safeToSpendCents).toBe(shortfall.safeToSpendCents);
    expect(plan.shortfallDisplayCents).toBe(79300);
    expect(plan.lowest).toEqual(shortfall.lowest);
    expect(plan.belowCushionFrom).toBe(shortfall.belowCushionFrom);
    expect(plan.belowZeroDates).toEqual(shortfall.belowZeroDates);
    expect(plan.billsBeforePayday.count).toBe(shortfall.itemsBeforePayday.count);
    expect(plan.billsBeforePayday.totalCents).toBe(shortfall.itemsBeforePayday.totalCents);
  });

  it("serves the three ways to cover the gap with the golden results", () => {
    expect(plan.shortfallOptions.map((o) => [o.kind, o.result.safeToSpendCents])).toEqual([
      ["move_from_emergency_fund", shortfall.options[0]?.safeToSpendCents],
      ["split_expense", shortfall.options[1]?.safeToSpendCents],
      ["move_bill_to_payday", shortfall.options[2]?.safeToSpendCents],
    ]);
  });
});

describe("GET /calendar", () => {
  it("November's totals match the fixture", () => {
    const cal = buildCalendar("base", "2026-11");
    expect(cal.summary).toMatchObject({
      incomeCents: expected.november.incomeCents,
      billsCount: expected.november.billsCount,
      billsCents: expected.november.billsCents,
      goalsAndPlannedCents: expected.november.goalsAndPlannedCents,
      leftForEverydayCents: expected.november.leftForEverydayCents,
    });
    const entries = cal.days.flatMap((d) => d.entries);
    expect(entries.filter((e) => e.kind === "income")).toHaveLength(3);
    expect(entries.filter((e) => e.isEstimate).map((e) => e.name)).toEqual(["Electricity", "Credit card"]);
  });

  it("filters entries by owner (Sam sees his items plus Both), and the summary follows the filter as the engine computes it", () => {
    const all = buildCalendar("base", "2026-11");
    const sam = buildCalendar("base", "2026-11", SAM_ID);
    const names = (c: typeof all) => c.days.flatMap((d) => d.entries.map((e) => e.name));
    expect(names(sam)).toContain("Daycare");
    expect(names(sam)).toContain("Thanksgiving");
    expect(names(sam)).not.toContain("Rent");
    expect(sam.summary.incomeCents).toBeLessThan(all.summary.incomeCents);
  });
});
