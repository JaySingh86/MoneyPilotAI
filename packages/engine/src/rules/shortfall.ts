// "Ways to cover the gap" (DESIGN_SPEC §5.3). Up to 3 options, in this order, each recalculated with
// rule 9:
//   1. Move money from the emergency fund: the smallest multiple of $100 that gives at least $50 a day,
//      capped at the fund balance.
//   2. Split the expense that caused the shortfall into two halves, before and after payday.
//   3. Move the largest bill in the window that could be moved to payday.
import { compareDates, compareStrings, parseDate } from "../dates";
import { ceilToMultiple } from "../money";
import { computePlan } from "../plan";
import type {
  EngineInput,
  GoalInput,
  ItemInput,
  OptionResult,
  PlanResult,
  PlannedExpenseInput,
  ShortfallOption,
} from "../types";
import { goalStatus } from "./goals";
import { whatIf } from "./what-if";

/** Option 1 aims for at least this much per day. */
export const SHORTFALL_TARGET_PER_DAY_CENTS = 5000;
/** Option 1 moves a multiple of $100. */
export const FUND_MOVE_STEP_CENTS = 10000;

/** Item kinds whose payee usually allows paying a few days later (QUESTIONS.md Q-016). */
const MOVABLE_KINDS: readonly ItemInput["kind"][] = [
  "subscription",
  "insurance",
  "membership",
  "registration",
  "other",
];

export function isMovable(item: ItemInput): boolean {
  return item.movable ?? MOVABLE_KINDS.includes(item.kind);
}

export function optionResult(plan: PlanResult): OptionResult {
  return {
    state: plan.state,
    safeToSpendCents: plan.safeToSpendCents,
    safeToSpendDisplayCents: plan.safeToSpendDisplayCents,
    shortfallDisplayCents: plan.shortfallDisplayCents,
    perDayCents: plan.perDayCents,
    minBalanceCents: plan.lowest.balanceCents,
    neverBelowZero: plan.lowest.balanceCents >= 0,
    effect: plan.safeToSpendCents >= 0 ? "ok" : "info",
  };
}

/**
 * Option 1. A transfer today raises every day of the runway by the same amount, so safe to spend rises by
 * exactly that amount; per day ≥ $50 means safe to spend ≥ $50 × days to payday.
 */
function fromEmergencyFund(input: EngineInput, base: PlanResult): ShortfallOption | null {
  const fund = input.goals.find((g) => g.emergencyFund === true && g.savedCents > 0);
  if (!fund) return null;
  const needed = SHORTFALL_TARGET_PER_DAY_CENTS * base.window.daysToPayday - base.safeToSpendCents;
  const wanted = ceilToMultiple(needed, FUND_MOVE_STEP_CENTS);
  const capped = wanted > fund.savedCents;
  const amountCents = capped ? fund.savedCents : wanted;
  const r = whatIf(input, [{ type: "add_transfer", amountCents, on: input.asOf, fromGoalId: fund.id }], base);
  const after = r.input.goals.find((g) => g.id === fund.id) as GoalInput;
  return {
    kind: "move_from_emergency_fund",
    goalId: fund.id,
    amountCents,
    capped,
    fundBalanceAfterCents: after.savedCents,
    reachMonthBefore: goalStatus(input, fund).reachMonth,
    reachMonthAfter: goalStatus(r.input, after).reachMonth,
    onlyIfAllowed: false,
    result: optionResult(r.plan),
  };
}

/** Option 2: the largest planned expense from today through the lowest day (ties: earliest, then id). */
function splitExpense(input: EngineInput, base: PlanResult): ShortfallOption | null {
  const from = parseDate(base.window.from);
  const lowestOn = parseDate(base.lowest.date);
  const cause = input.plannedExpenses
    .filter((p) => (p.status ?? "planned") === "planned" && p.amountCents >= 2)
    .filter((p) => {
      const d = parseDate(p.dueOn);
      return compareDates(d, from) >= 0 && compareDates(d, lowestOn) <= 0;
    })
    .sort(
      (a: PlannedExpenseInput, b: PlannedExpenseInput) =>
        b.amountCents - a.amountCents || compareStrings(a.dueOn, b.dueOn) || compareStrings(a.id, b.id),
    )[0];
  if (!cause) return null;
  const amountNowCents = Math.floor(cause.amountCents / 2);
  const afterPaydayOn = parseDate(base.window.to).add({ days: 1 }).toString();
  const r = whatIf(
    input,
    [{ type: "split_planned_expense", plannedExpenseId: cause.id, amountNowCents, laterOn: afterPaydayOn }],
    base,
  );
  return {
    kind: "split_expense",
    plannedExpenseId: cause.id,
    amountNowCents,
    amountAfterPaydayCents: cause.amountCents - amountNowCents,
    nowOn: parseDate(cause.dueOn).toString(),
    afterPaydayOn,
    onlyIfAllowed: true,
    result: optionResult(r.plan),
  };
}

/**
 * Option 3: the largest movable bill due in the window before payday whose move to payday changes safe to
 * spend (rule 9). Ties: earliest date, then item id.
 */
function moveBillToPayday(input: EngineInput, base: PlanResult): ShortfallOption | null {
  const items = new Map(input.items.map((i) => [i.id, i]));
  const payday = base.window.to;
  const candidates = base.runway
    .flatMap((d) => d.events)
    .filter((e) => e.kind === "bill" && e.status === "scheduled" && e.date < payday)
    .filter((e) => isMovable(items.get(e.sourceId) as ItemInput))
    .sort(
      (a, b) =>
        a.amountCents - b.amountCents ||
        compareStrings(a.date, b.date) ||
        compareStrings(a.sourceId, b.sourceId),
    );
  for (const e of candidates) {
    const r = whatIf(
      input,
      [{ type: "move_occurrence", itemId: e.sourceId, scheduledOn: e.scheduledOn, toDate: payday }],
      base,
    );
    if (!r.diff.changesSafeToSpend) continue;
    return {
      kind: "move_bill_to_payday",
      itemId: e.sourceId,
      itemKind: (items.get(e.sourceId) as ItemInput).kind,
      scheduledOn: e.scheduledOn,
      fromDate: e.date,
      toDate: payday,
      amountCents: -e.amountCents,
      onlyIfAllowed: true,
      result: optionResult(r.plan),
    };
  }
  return null;
}

/** "Ways to cover the gap": empty unless the plan is in the shortfall state. */
export function shortfallOptions(
  input: EngineInput,
  base: PlanResult = computePlan(input),
): ShortfallOption[] {
  if (base.state !== "shortfall") return [];
  return [fromEmergencyFund(input, base), splitExpense(input, base), moveBillToPayday(input, base)].filter(
    (o): o is ShortfallOption => o !== null,
  );
}
