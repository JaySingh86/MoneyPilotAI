import { computePlan } from "../plan";
import { riveraInput } from "../testing";
import type { EngineInput, GoalInput, ItemInput, ShortfallOption } from "../types";
import { isMovable, optionResult, shortfallOptions } from "./shortfall";

const shortfall = () => riveraInput({ scenario: "shortfall" });
const kinds = (options: ShortfallOption[]) => options.map((o) => o.kind);

function goal(input: EngineInput, id: string): GoalInput {
  return input.goals.find((g) => g.id === id) as GoalInput;
}

describe("shortfallOptions (DESIGN_SPEC §5.3)", () => {
  it("is empty when on track", () => {
    expect(shortfallOptions(riveraInput())).toEqual([]);
  });

  it("caps the fund move at the fund balance", () => {
    const input = shortfall();
    goal(input, "g-emergency").savedCents = 100050;
    const [o] = shortfallOptions(input);
    expect(o).toMatchObject({
      kind: "move_from_emergency_fund",
      amountCents: 100050,
      capped: true,
      fundBalanceAfterCents: 0,
      reachMonthAfter: "2029-08", // ceil($10,000 ÷ $300) = 34 deposits from Nov 2026
    });
    expect(o?.result).toMatchObject({ safeToSpendCents: 20751, effect: "ok" });
  });

  it("skips option 1 without an emergency fund, or with an empty one", () => {
    const none = shortfall();
    goal(none, "g-emergency").emergencyFund = false;
    expect(kinds(shortfallOptions(none))).toEqual(["split_expense", "move_bill_to_payday"]);
    const empty = shortfall();
    goal(empty, "g-emergency").savedCents = 0;
    expect(kinds(shortfallOptions(empty))).toEqual(["split_expense", "move_bill_to_payday"]);
  });

  it("skips option 2 when no planned expense falls before the lowest day", () => {
    // Same shortfall, caused by a lower balance instead of a planned expense.
    const input = riveraInput();
    input.startingBalance = { cents: 160000, asOf: "2026-10-27" };
    expect(kinds(shortfallOptions(input))).toEqual(["move_from_emergency_fund", "move_bill_to_payday"]);
  });

  it("splits the largest planned expense up to the lowest day, odd cents going after payday", () => {
    const input = shortfall();
    input.plannedExpenses.push(
      { id: "p-small", name: "Small", owner: "both", amountCents: 1, dueOn: "2026-10-29" },
      { id: "p-odd", name: "Odd", owner: "both", amountCents: 180001, dueOn: "2026-10-30" },
      { id: "p-tie", name: "Tie", owner: "both", amountCents: 180001, dueOn: "2026-10-30" },
      { id: "p-done", name: "Done", owner: "both", amountCents: 900000, dueOn: "2026-10-29", status: "done" },
      { id: "p-before", name: "Before", owner: "both", amountCents: 900000, dueOn: "2026-10-26" },
    );
    const o = shortfallOptions(input).find((x) => x.kind === "split_expense");
    expect(o).toMatchObject({
      plannedExpenseId: "p-odd",
      amountNowCents: 90000,
      amountAfterPaydayCents: 90001,
    });
  });

  it("prefers the earlier of two equal planned expenses", () => {
    const input = shortfall();
    input.plannedExpenses.push({
      id: "p-a",
      name: "A",
      owner: "both",
      amountCents: 180000,
      dueOn: "2026-10-29",
    });
    const o = shortfallOptions(input).find((x) => x.kind === "split_expense");
    expect(o).toMatchObject({ plannedExpenseId: "p-repair" });
  });

  it("moves the largest movable bill whose move changes safe to spend", () => {
    const input = shortfall();
    // Car insurance is not movable here; the streaming bundle (Nov 2) is the next largest movable bill.
    (input.items.find((i) => i.id === "b-carins") as ItemInput).movable = false;
    const o = shortfallOptions(input).find((x) => x.kind === "move_bill_to_payday");
    expect(o).toMatchObject({
      itemId: "b-stream",
      itemKind: "subscription",
      fromDate: "2026-11-02",
      amountCents: 2299,
    });
  });

  it("skips a movable bill whose move changes nothing, and gives up when none helps", () => {
    const input = shortfall();
    for (const i of input.items) i.movable = false;
    expect(kinds(shortfallOptions(input))).toEqual(["move_from_emergency_fund", "split_expense"]);
    // A $0 movable bill is a candidate but moving it changes nothing.
    const zero = shortfall();
    for (const i of zero.items) i.movable = false;
    zero.items.push({
      id: "b-zero",
      name: "Zero",
      direction: "outflow",
      kind: "subscription",
      owner: "m-sam",
      amount: { type: "fixed", cents: 0 },
      schedule: { type: "monthly_day", day: 1, dtstart: "2026-01-01" },
    });
    expect(kinds(shortfallOptions(zero))).toEqual(["move_from_emergency_fund", "split_expense"]);
  });

  it("accepts a precomputed base plan", () => {
    const input = shortfall();
    expect(shortfallOptions(input, computePlan(input))).toHaveLength(3);
  });
});

describe("isMovable (QUESTIONS.md Q-016)", () => {
  const base: ItemInput = {
    id: "x",
    name: "X",
    direction: "outflow",
    kind: "bill",
    owner: "m-a",
    amount: { type: "fixed", cents: 1 },
    schedule: { type: "monthly_day", day: 1, dtstart: "2026-01-01" },
  };
  it.each([
    ["bill", false],
    ["loan", false],
    ["income", false],
    ["subscription", true],
    ["insurance", true],
    ["membership", true],
    ["registration", true],
    ["other", true],
  ] as const)("%s → %s by default", (kind, movable) => {
    expect(isMovable({ ...base, kind })).toBe(movable);
  });
  it("an explicit flag wins", () => {
    expect(isMovable({ ...base, movable: true })).toBe(true);
    expect(isMovable({ ...base, kind: "insurance", movable: false })).toBe(false);
  });
});

describe("optionResult", () => {
  it("reports the effect chip and whether the balance stays above $0", () => {
    const r = optionResult(computePlan(shortfall()));
    expect(r).toMatchObject({
      state: "shortfall",
      effect: "info",
      neverBelowZero: false,
      minBalanceCents: -29299,
    });
  });
});
