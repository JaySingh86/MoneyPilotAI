// Golden test for WP-07: every value under `expected` that the core golden test (src/golden.test.ts) does
// not cover, and every value under `scenarios.shortfall.expected.options`. Display strings are rebuilt from
// engine values with the small helpers below, so the engine never formats money (packages/format does).
import { riveraFixture, riveraInput, RIVERA_TASKS } from "../testing";
import type { FullPlanResult, ShortfallOption } from "../types";
import { billsAverages } from "./bills-averages";
import { calendarMonth } from "./calendar";
import { estimate } from "./estimate";
import { computeFullPlan } from "./full-plan";
import { goalStatus, goalsSummary } from "./goals";
import { renewalsSummary } from "./renewals";
import { tasksDueThisWeek } from "./tasks";
import { whatIf } from "./what-if";

const expected = riveraFixture.expected;
const shortfallExpected = riveraFixture.scenarios.shortfall.expected;

/** `$1,007` for whole-dollar amounts. Test-only. */
function wholeDollars(cents: number): string {
  if (cents % 100 !== 0) throw new Error("not whole dollars");
  return `$${String(Math.abs(cents) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2027-10` → `Oct 2027`. Test-only. */
function monthLabel(yearMonth: string | null): string {
  if (yearMonth === null) throw new Error("no month");
  const [year, month] = yearMonth.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

function goal(id: string) {
  const input = riveraInput();
  const g = input.goals.find((x) => x.id === id);
  if (!g) throw new Error(`no goal ${id}`);
  return goalStatus(input, g);
}

describe("golden: Rivera household, WP-07 rules (expected)", () => {
  it("safeToSpendIfCarInsuranceMovedToPaydayCents via whatIf (rule 9)", () => {
    const r = whatIf(riveraInput(), [
      { type: "move_occurrence", itemId: "b-carins", scheduledOn: "2026-11-04", toDate: "2026-11-06" },
    ]);
    expect(r.plan.safeToSpendCents).toBe(expected.safeToSpendIfCarInsuranceMovedToPaydayCents);
    expect(r.diff.changesSafeToSpend).toBe(true);
  });

  it("safeToSpendAfterElectricityActual15137Cents via whatIf (rule 6)", () => {
    const r = whatIf(riveraInput(), [
      { type: "set_actual_amount", itemId: "b-power", scheduledOn: "2026-11-03", amountCents: 15137 },
    ]);
    expect(r.plan.safeToSpendCents).toBe(expected.safeToSpendAfterElectricityActual15137Cents);
    expect(r.diff.deltaCents).toBe(-937);
    // "Safe to spend is now $997" (DESIGN_SPEC §5.1; Q-018: rule 4 floors $997.64).
    expect(wholeDollars(r.plan.safeToSpendDisplayCents ?? Number.NaN)).toBe("$997");
  });

  it("electricityEstimate", () => {
    const power = riveraInput().items.find((i) => i.id === "b-power");
    if (!power) throw new Error("no electricity");
    const e = estimate(power);
    expect(e.amountCents).toBe(expected.electricityEstimate.amountCents);
    expect(`±${wholeDollars(e.rangeCents ?? Number.NaN)}`).toBe(expected.electricityEstimate.rangeDisplay);
  });

  it("tahoeGoal", () => {
    const s = goal("g-tahoe");
    expect(s.projectedByTargetCents).toBe(expected.tahoeGoal.projectedByTargetCents);
    expect(s.gapCents).toBe(expected.tahoeGoal.gapCents);
    expect(s.suggestedMonthlyCents).toBe(expected.tahoeGoal.suggestedMonthlyCents);
    expect(s.alternativeTargetDate).toBe(expected.tahoeGoal.alternativeTargetDate);
  });

  it("november (calendar month at a glance)", () => {
    const m = calendarMonth(riveraInput(), "2026-11");
    expect(m.summary.incomeCents).toBe(expected.november.incomeCents);
    expect(m.summary.billsCount).toBe(expected.november.billsCount);
    expect(m.summary.billsCents).toBe(expected.november.billsCents);
    expect(m.summary.goalsAndPlannedCents).toBe(expected.november.goalsAndPlannedCents);
    expect(m.summary.leftForEverydayCents).toBe(expected.november.leftForEverydayCents);
  });

  it("renewals", () => {
    const r = renewalsSummary(riveraInput());
    expect(r.count).toBe(expected.renewals.count);
    expect(r.yearlyCents).toBe(expected.renewals.yearlyCents);
    expect(r.next90Days.cents).toBe(expected.renewals.bigRenewalsNext90DaysCents);
    expect(r.priceIncreaseYearlyCents).toBe(expected.renewals.priceIncreaseYearlyCents);
    expect(r.couldSaveYearlyCents).toBe(expected.renewals.couldSaveYearlyCents);
    expect(r.foundAutomatically).toBe(expected.renewals.foundAutomatically);
    // DESIGN_SPEC §5.1 Renewals golden values: "about $566 a month", "4 payments + 1 plan decision".
    expect(r.monthlyAverageCents).toBe(56561);
    expect(r.next90Days.count).toBe(4);
    expect(r.next90Days.planDecisions).toBe(1);
  });

  it("billsPage", () => {
    const b = billsAverages(riveraInput());
    expect(b.rows).toBe(expected.billsPage.rows);
    expect(b.monthlyBillsAverageCents).toBe(expected.billsPage.monthlyBillsAverageCents);
    expect(b.monthlyIncomeAverageCents).toBe(expected.billsPage.monthlyIncomeAverageCents);
    expect(b.leftAfterBillsCents).toBe(expected.billsPage.leftAfterBillsCents);
    expect(b.estimatesToConfirm).toBe(expected.billsPage.estimatesToConfirm);
  });

  describe("goalsPage", () => {
    const g = goalsSummary(riveraInput());

    it("savingEachMonth, savedSoFar, effectOnSafeToSpend", () => {
      expect(g.savingEachMonthCents).toBe(expected.goalsPage.savingEachMonthCents);
      expect(g.savedSoFarCents).toBe(expected.goalsPage.savedSoFarCents);
      expect(g.effectOnSafeToSpendCents).toBe(expected.goalsPage.effectOnSafeToSpendCents);
    });

    it("emergency", () => {
      const s = goal("g-emergency");
      expect(s.percent).toBe(expected.goalsPage.emergency.percent);
      expect(s.status).toBe("reach_month");
      expect(`Reached in ${monthLabel(s.reachMonth)}`).toBe(expected.goalsPage.emergency.status);
    });

    it("tahoe", () => {
      const s = goal("g-tahoe");
      expect(s.percent).toBe(expected.goalsPage.tahoe.percent);
      expect(s.status).toBe("behind");
      expect(`${wholeDollars(s.gapCents ?? Number.NaN)} behind`).toBe(expected.goalsPage.tahoe.status);
      expect(s.suggestedMonthlyCents).toBe(expected.goalsPage.tahoe.suggestedMonthlyCents);
    });

    it("gifts", () => {
      const s = goal("g-gifts");
      expect(s.percent).toBe(expected.goalsPage.gifts.percent);
      expect(s.status).toBe("to_set_aside");
      expect(`${wholeDollars(s.gapCents ?? Number.NaN)} to set aside`).toBe(expected.goalsPage.gifts.status);
      expect(s.suggestedMonthlyCents).toBe(expected.goalsPage.gifts.suggestedMonthlyCents);
    });

    it("lists every goal in input order", () => {
      expect(g.goals.map((x) => x.goalId)).toEqual(["g-emergency", "g-tahoe", "g-gifts"]);
    });
  });

  it("tasks", () => {
    const t = tasksDueThisWeek(RIVERA_TASKS, riveraFixture.today);
    expect(t.dueThisWeek).toHaveLength(expected.tasks.dueThisWeek);
    expect(t.later).toHaveLength(expected.tasks.later);
    expect(t.done).toHaveLength(expected.tasks.done);
    expect(t.navBadge).toBe(expected.tasks.navBadge);
  });
});

describe("golden: Rivera shortfall scenario options (scenarios.shortfall.expected.options)", () => {
  const plan: FullPlanResult = computeFullPlan(riveraInput({ scenario: "shortfall" }));

  function option<K extends ShortfallOption["kind"]>(kind: K): Extract<ShortfallOption, { kind: K }> {
    const o = plan.shortfallOptions.find((x): x is Extract<ShortfallOption, { kind: K }> => x.kind === kind);
    if (!o) throw new Error(`no option ${kind}`);
    return o;
  }

  function optionDisplay(o: ShortfallOption): string {
    const r = o.result;
    if (r.state === "on_track")
      return `${wholeDollars(r.safeToSpendDisplayCents ?? Number.NaN)} safe to spend`;
    const short = `${wholeDollars(r.shortfallDisplayCents ?? Number.NaN)} short`;
    return r.neverBelowZero ? `${short}, never below $0` : short;
  }

  it("is in the shortfall state with the hero value", () => {
    expect(plan.state).toBe("shortfall");
    expect(`${wholeDollars(plan.shortfallDisplayCents ?? Number.NaN)} short`).toBe(
      shortfallExpected.heroDisplay,
    );
  });

  it("lists the three options in the spec's order", () => {
    expect(plan.shortfallOptions.map((o) => o.kind)).toEqual([
      "move_from_emergency_fund",
      "split_expense",
      "move_bill_to_payday",
    ]);
    expect(shortfallExpected.options.map((o) => o.id)).toEqual([
      "move-from-emergency",
      "split-repair",
      "car-insurance-on-payday",
    ]);
  });

  it("option 1: move-from-emergency ($507, Mar 2028)", () => {
    const e = shortfallExpected.options[0];
    if (e?.id !== "move-from-emergency") throw new Error("fixture order");
    const o = option("move_from_emergency_fund");
    expect(o.goalId).toBe("g-emergency");
    expect(o.amountCents).toBe(e.amountCents);
    expect(o.result.safeToSpendCents).toBe(e.safeToSpendCents);
    expect(optionDisplay(o)).toBe(e.display);
    expect(monthLabel(o.reachMonthAfter)).toBe(e.emergencyReachMonth);
    // Canvas: "The fund drops to $5,100. Reaching $10,000 moves from Oct 2027 to Mar 2028."
    expect(o.fundBalanceAfterCents).toBe(510000);
    expect(monthLabel(o.reachMonthBefore)).toBe("Oct 2027");
    expect(o.result.effect).toBe("ok");
    expect(o.result.perDayCents).toBe(5000);
  });

  it("option 2: split-repair ($107)", () => {
    const e = shortfallExpected.options[1];
    if (e?.id !== "split-repair") throw new Error("fixture order");
    const o = option("split_expense");
    expect(o.plannedExpenseId).toBe("p-repair");
    expect(o.amountNowCents).toBe(e.amountNowCents);
    expect(o.amountAfterPaydayCents).toBe(e.amountAfterPaydayCents);
    expect(o.result.safeToSpendCents).toBe(e.safeToSpendCents);
    expect(optionDisplay(o)).toBe(e.display);
    expect(o.nowOn).toBe("2026-10-28");
    expect(o.afterPaydayOn).toBe("2026-11-07");
    expect(o.onlyIfAllowed).toBe(true);
  });

  it("option 3: car-insurance-on-payday ($109 short, never below $0)", () => {
    const e = shortfallExpected.options[2];
    if (e?.id !== "car-insurance-on-payday") throw new Error("fixture order");
    const o = option("move_bill_to_payday");
    expect(o.itemId).toBe("b-carins");
    expect(o.fromDate).toBe("2026-11-04");
    expect(o.toDate).toBe("2026-11-06");
    expect(o.result.safeToSpendCents).toBe(e.safeToSpendCents);
    expect(o.result.minBalanceCents).toBe(e.minBalanceCents);
    expect(optionDisplay(o)).toBe(e.display);
    expect(o.result.effect).toBe("info");
  });
});
