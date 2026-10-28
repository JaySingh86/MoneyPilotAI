import { riveraInput } from "../testing";
import type { EngineInput, GoalInput } from "../types";
import { goalDepositDates, goalStatus, goalsSummary, suggestMonthly } from "./goals";

function take(input: EngineInput, n: number): string[] {
  const out: string[] = [];
  for (const d of goalDepositDates(input)) {
    out.push(d.toString());
    if (out.length === n) break;
  }
  return out;
}

const goal = (g: Partial<GoalInput>): GoalInput => ({
  id: "g",
  name: "Goal",
  type: "savings",
  targetCents: 100000,
  savedCents: 0,
  monthlyCents: 10000,
  targetDate: null,
  ...g,
});

describe("goal deposit dates (rules 10, 16)", () => {
  it("are the first primary payday of each month, from the next payday on", () => {
    expect(take(riveraInput(), 6)).toEqual([
      "2026-11-06",
      "2026-12-04",
      "2027-01-01",
      "2027-02-12",
      "2027-03-12",
      "2027-04-09",
    ]);
  });

  it("skip a month whose first payday is before asOf", () => {
    const input = { ...riveraInput(), asOf: "2026-11-10", startingBalance: { cents: 0, asOf: "2026-11-10" } };
    expect(take(input, 2)).toEqual(["2026-12-04", "2027-01-01"]);
  });

  it("include asOf when it is the month's first payday", () => {
    const input = { ...riveraInput(), asOf: "2026-11-06", startingBalance: { cents: 0, asOf: "2026-11-06" } };
    expect(take(input, 1)).toEqual(["2026-11-06"]);
  });
});

describe("suggestMonthly (rule 10)", () => {
  it("ceils to whole dollars", () => {
    expect(suggestMonthly(125000, 4)).toBe(31300);
    expect(suggestMonthly(38000, 2)).toBe(19000);
    expect(suggestMonthly(100, 3)).toBe(100); // 33.3¢ → $1
  });
  it("is null with no contributions and 0 with nothing remaining", () => {
    expect(suggestMonthly(100, 0)).toBeNull();
    expect(suggestMonthly(0, 3)).toBe(0);
  });
});

describe("goalStatus (rules 10, 16)", () => {
  const input = riveraInput();

  it("reach month for a goal without a target date", () => {
    const s = goalStatus(input, goal({ targetCents: 1000000, savedCents: 640000, monthlyCents: 30000 }));
    expect(s).toMatchObject({
      status: "reach_month",
      reachMonth: "2027-10",
      percent: 64,
      remainingCents: 360000,
    });
    expect(s.gapCents).toBeNull();
  });

  it("caps the percent of an unreached goal at 99", () => {
    expect(goalStatus(input, goal({ targetCents: 100000, savedCents: 99600 })).percent).toBe(99);
    expect(goalStatus(input, goal({ targetCents: 100000, savedCents: 100000 })).percent).toBe(100);
  });

  it("no monthly amount", () => {
    expect(goalStatus(input, goal({ monthlyCents: null })).status).toBe("no_monthly_amount");
    expect(goalStatus(input, goal({ monthlyCents: 0 })).reachMonth).toBeNull();
  });

  it("unreachable within the horizon", () => {
    const s = goalStatus(input, goal({ targetCents: 100000000, monthlyCents: 1 }));
    expect(s).toMatchObject({ status: "unreachable", reachMonth: null });
  });

  it("reached, with percent capped at 100", () => {
    const s = goalStatus(input, goal({ targetCents: 1000, savedCents: 1500 }));
    expect(s).toMatchObject({ status: "reached", percent: 100, remainingCents: 0, reachMonth: null });
    expect(goalStatus(input, goal({ targetCents: 0, savedCents: 0 })).percent).toBe(100);
  });

  it("on track for a target date", () => {
    const s = goalStatus(
      input,
      goal({ targetCents: 240000, savedCents: 115000, monthlyCents: 31300, targetDate: "2027-03-01" }),
    );
    expect(s).toMatchObject({
      status: "on_track",
      contributionsByTarget: 4,
      projectedByTargetCents: 240200,
      gapCents: null,
      suggestedMonthlyCents: 31300,
      alternativeTargetDate: null,
    });
  });

  it("behind (savings) with the rule 10 options", () => {
    const s = goalStatus(
      input,
      goal({ targetCents: 240000, savedCents: 115000, monthlyCents: 25000, targetDate: "2027-03-01" }),
    );
    expect(s).toMatchObject({
      status: "behind",
      gapCents: 25000,
      projectedByTargetCents: 215000,
      suggestedMonthlyCents: 31300,
      alternativeTargetDate: "2027-04-01",
      reachMonth: "2027-03",
    });
  });

  it("moves the date several months when needed, clamping the day", () => {
    const s = goalStatus(
      input,
      goal({ targetCents: 100000, savedCents: 0, monthlyCents: 10000, targetDate: "2027-01-31" }),
    );
    // 3 deposits by Jan 31; the 10th is Aug 13, 2027. The first Jan 31 + k months on or after it is Aug 31.
    expect(s.status).toBe("behind");
    expect(s.alternativeTargetDate).toBe("2027-08-31");
  });

  it("to set aside (planned expense) without a monthly amount", () => {
    const s = goalStatus(
      input,
      goal({
        type: "planned_expense",
        targetCents: 80000,
        savedCents: 42000,
        monthlyCents: null,
        targetDate: "2026-12-15",
      }),
    );
    expect(s).toMatchObject({
      status: "to_set_aside",
      gapCents: 38000,
      suggestedMonthlyCents: 19000,
      alternativeTargetDate: null,
      percent: 53,
    });
  });

  it("no suggestion when the target date is before the next deposit", () => {
    const s = goalStatus(input, goal({ targetDate: "2026-11-01" }));
    expect(s).toMatchObject({ status: "behind", contributionsByTarget: 0, suggestedMonthlyCents: null });
  });

  it("no alternative date when the deposits never close the gap", () => {
    const s = goalStatus(input, goal({ targetCents: 100000000, monthlyCents: 1, targetDate: "2027-01-01" }));
    expect(s).toMatchObject({ status: "behind", alternativeTargetDate: null });
  });

  it("defaults the type to savings", () => {
    const g = goal({ targetDate: "2026-11-01" });
    delete g.type;
    expect(goalStatus(input, g).status).toBe("behind");
  });
});

describe("goalsSummary", () => {
  it("counts only goals not yet reached in the monthly total", () => {
    const input = riveraInput();
    input.goals.push(goal({ id: "g-done", targetCents: 100, savedCents: 100, monthlyCents: 5000 }));
    const s = goalsSummary(input);
    expect(s.savingEachMonthCents).toBe(55000);
    expect(s.savedSoFarCents).toBe(797100);
  });

  it("reports the effect on safe to spend of transfers inside the window", () => {
    // On payday (Nov 6) the window runs to Nov 20, so the Nov 6 transfers are inside it.
    const input = {
      ...riveraInput(),
      asOf: "2026-11-06",
      startingBalance: { cents: 340000, asOf: "2026-11-06" },
    };
    expect(goalsSummary(input).effectOnSafeToSpendCents).toBe(-55000);
  });
});
