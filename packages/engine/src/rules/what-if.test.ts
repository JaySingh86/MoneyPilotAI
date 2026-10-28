import { EngineError } from "../errors";
import { computePlan } from "../plan";
import { riveraInput } from "../testing";
import type { PlanChange } from "../types";
import { applyChanges, planDiff, whatIf } from "./what-if";

describe("whatIf (rule 9)", () => {
  it("moves one occurrence and reports the diff; the series keeps its scheduled date", () => {
    const input = riveraInput();
    const r = whatIf(input, [
      { type: "move_occurrence", itemId: "b-carins", scheduledOn: "2026-11-04", toDate: "2026-11-06" },
    ]);
    expect(r.input.occurrences).toEqual([
      { itemId: "b-carins", scheduledOn: "2026-11-04", dueOn: "2026-11-06" },
    ]);
    expect(r.diff).toEqual({
      stateBefore: "on_track",
      stateAfter: "on_track",
      safeToSpendBeforeCents: 100701,
      safeToSpendAfterCents: 169101,
      deltaCents: 68400,
      changesSafeToSpend: true,
      lowestBefore: { date: "2026-11-05", balanceCents: 150701 },
      lowestAfter: { date: "2026-11-05", balanceCents: 219101 },
    });
    // The caller's input is untouched.
    expect(input.occurrences).toEqual([]);
  });

  it("updates an existing occurrence row instead of adding one", () => {
    const input = riveraInput({
      occurrences: [{ itemId: "b-power", scheduledOn: "2026-11-03", status: "scheduled" }],
    });
    const changed = applyChanges(input, [
      { type: "set_actual_amount", itemId: "b-power", scheduledOn: "2026-11-03", amountCents: 15137 },
    ]);
    expect(changed.occurrences).toEqual([
      { itemId: "b-power", scheduledOn: "2026-11-03", status: "scheduled", actualAmountCents: 15137 },
    ]);
    expect(input.occurrences[0]?.actualAmountCents).toBeUndefined();
  });

  it("does not change safe to spend when a bill moves within the same day range after the lowest point", () => {
    const r = whatIf(riveraInput(), [
      { type: "move_occurrence", itemId: "b-news", scheduledOn: "2026-11-08", toDate: "2026-11-09" },
    ]);
    expect(r.diff.changesSafeToSpend).toBe(false);
    expect(r.diff.deltaCents).toBe(0);
  });

  it("splits a planned expense into now and later", () => {
    const input = riveraInput({ scenario: "shortfall" });
    const r = whatIf(input, [
      {
        type: "split_planned_expense",
        plannedExpenseId: "p-repair",
        amountNowCents: 90000,
        laterOn: "2026-11-07",
      },
    ]);
    const parts = r.input.plannedExpenses.filter((p) => p.id.startsWith("p-repair"));
    expect(parts).toEqual([
      expect.objectContaining({ id: "p-repair", amountCents: 90000, dueOn: "2026-10-28" }),
      expect.objectContaining({ id: "p-repair:later", amountCents: 90000, dueOn: "2026-11-07" }),
    ]);
    expect(r.plan.safeToSpendCents).toBe(10701);
  });

  it("adds a transfer, from a goal or from outside", () => {
    const input = riveraInput({ scenario: "shortfall" });
    const fromGoal = whatIf(input, [
      { type: "add_transfer", amountCents: 130000, on: "2026-10-27", fromGoalId: "g-emergency" },
    ]);
    expect(fromGoal.plan.safeToSpendCents).toBe(50701);
    expect(fromGoal.input.goals.find((g) => g.id === "g-emergency")?.savedCents).toBe(510000);
    const outside = whatIf(input, [{ type: "add_transfer", amountCents: 100, on: "2026-10-27" }]);
    expect(outside.diff.deltaCents).toBe(100);
    expect(outside.input.goals).toEqual(input.goals);
  });

  it("changes an item amount and a goal's monthly deposit", () => {
    const input = riveraInput();
    const r = whatIf(input, [
      { type: "set_item_amount", itemId: "b-power", amountCents: 14300 },
      { type: "set_goal_monthly", goalId: "g-tahoe", monthlyCents: 31300 },
    ]);
    expect(r.diff.deltaCents).toBe(-100);
    expect(r.input.goals.find((g) => g.id === "g-tahoe")?.monthlyCents).toBe(31300);
  });

  it("compares displayed dollars, not cents", () => {
    // $1,007.01 and $1,007.00 both display as $1,007.
    const same = whatIf(riveraInput(), [{ type: "set_item_amount", itemId: "b-power", amountCents: 14201 }]);
    expect(same.diff.deltaCents).toBe(-1);
    expect(same.diff.changesSafeToSpend).toBe(false);
    // $1,007.01 → $1,006.99 crosses a dollar.
    const crossed = whatIf(riveraInput(), [
      { type: "set_item_amount", itemId: "b-power", amountCents: 14202 },
    ]);
    expect(crossed.diff.changesSafeToSpend).toBe(true);
    // A shortfall of $792.99 and $792.01 both display as "$793 short".
    const base = riveraInput({ scenario: "shortfall" });
    const sameShort = whatIf(base, [{ type: "set_item_amount", itemId: "b-internet", amountCents: 6900 }]);
    expect(sameShort.diff.changesSafeToSpend).toBe(true);
    const sameShort2 = whatIf(base, [{ type: "add_transfer", amountCents: 98, on: "2026-10-27" }]);
    expect(sameShort2.diff.changesSafeToSpend).toBe(false);
  });

  it("names the one-off transfer by code", () => {
    const r = whatIf(riveraInput(), [{ type: "add_transfer", amountCents: 100, on: "2026-10-27" }]);
    expect(r.input.items.find((i) => i.id.startsWith("what-if:transfer"))?.name).toBe("what_if_transfer");
  });

  it("accepts a precomputed base plan", () => {
    const input = riveraInput();
    const base = computePlan(input);
    expect(whatIf(input, [], base).diff.changesSafeToSpend).toBe(false);
    expect(planDiff(base, base).deltaCents).toBe(0);
  });

  it.each<[string, PlanChange]>([
    [
      "unknown item",
      { type: "move_occurrence", itemId: "nope", scheduledOn: "2026-11-04", toDate: "2026-11-06" },
    ],
    [
      "no occurrence on that date",
      { type: "move_occurrence", itemId: "b-carins", scheduledOn: "2026-11-05", toDate: "2026-11-06" },
    ],
    [
      "negative actual",
      { type: "set_actual_amount", itemId: "b-power", scheduledOn: "2026-11-03", amountCents: -1 },
    ],
    [
      "unknown planned expense",
      { type: "split_planned_expense", plannedExpenseId: "nope", amountNowCents: 1, laterOn: "2026-11-07" },
    ],
    [
      "split of 0",
      {
        type: "split_planned_expense",
        plannedExpenseId: "p-thanks",
        amountNowCents: 0,
        laterOn: "2026-11-27",
      },
    ],
    [
      "split of the whole",
      {
        type: "split_planned_expense",
        plannedExpenseId: "p-thanks",
        amountNowCents: 25000,
        laterOn: "2026-11-27",
      },
    ],
    ["transfer of 0", { type: "add_transfer", amountCents: 0, on: "2026-10-27" }],
    [
      "transfer from an unknown goal",
      { type: "add_transfer", amountCents: 1, on: "2026-10-27", fromGoalId: "nope" },
    ],
    [
      "transfer above the goal",
      { type: "add_transfer", amountCents: 640001, on: "2026-10-27", fromGoalId: "g-emergency" },
    ],
    ["negative item amount", { type: "set_item_amount", itemId: "b-power", amountCents: -1 }],
    ["negative monthly", { type: "set_goal_monthly", goalId: "g-tahoe", monthlyCents: -1 }],
    ["unknown goal", { type: "set_goal_monthly", goalId: "nope", monthlyCents: 1 }],
    ["unknown change type", { type: "pay_bill" } as unknown as PlanChange],
  ])("rejects %s", (_name, change) => {
    expect(() => applyChanges(riveraInput(), [change])).toThrow(EngineError);
  });

  it("rejects fractional cents", () => {
    expect(() =>
      applyChanges(riveraInput(), [{ type: "set_item_amount", itemId: "b-power", amountCents: 1.5 }]),
    ).toThrow(EngineError);
  });
});
