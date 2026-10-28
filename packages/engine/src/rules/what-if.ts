// Rule 9: what-if. Applies changes to a copy of the input and re-runs rules 2–4 (the core plan).
import { parseDate } from "../dates";
import { EngineError } from "../errors";
import { assertCents } from "../money";
import { computePlan } from "../plan";
import { expandSchedule } from "../schedule/expand";
import type {
  Cents,
  EngineInput,
  GoalInput,
  ItemInput,
  OccurrenceInput,
  PlanChange,
  PlanDiff,
  PlanResult,
  WhatIfResult,
} from "../types";

function invalid(detail: string): never {
  throw new EngineError("invalid_input", detail);
}

function positiveCents(value: number, field: string): void {
  assertCents(value, field);
  if (value <= 0) invalid(`${field} must be positive`);
}

/** A copy deep enough that changes never touch the caller's input. */
function copyInput(input: EngineInput): EngineInput {
  return {
    ...input,
    items: input.items.map((i) => ({ ...i })),
    occurrences: input.occurrences.map((o) => ({ ...o })),
    plannedExpenses: input.plannedExpenses.map((p) => ({ ...p })),
    goals: input.goals.map((g) => ({ ...g })),
  };
}

function findItem(input: EngineInput, itemId: string): ItemInput {
  return input.items.find((i) => i.id === itemId) ?? invalid("change for an unknown item");
}

function findGoal(input: EngineInput, goalId: string): GoalInput {
  return input.goals.find((g) => g.id === goalId) ?? invalid("change for an unknown goal");
}

/** The occurrence row for (item, scheduledOn), created if the schedule has that date. */
function occurrenceRow(input: EngineInput, itemId: string, scheduledOn: string): OccurrenceInput {
  const item = findItem(input, itemId);
  const date = parseDate(scheduledOn, "change.scheduledOn");
  const key = date.toString();
  const existing = input.occurrences.find(
    (o) => o.itemId === itemId && parseDate(o.scheduledOn).equals(date),
  );
  if (existing) return existing;
  if (expandSchedule(item.schedule, date, date).length === 0) invalid("no occurrence on that date");
  const row: OccurrenceInput = { itemId, scheduledOn: key };
  input.occurrences.push(row);
  return row;
}

function applyChange(input: EngineInput, change: PlanChange, index: number): void {
  switch (change.type) {
    case "move_occurrence": {
      const to = parseDate(change.toDate, "change.toDate").toString();
      occurrenceRow(input, change.itemId, change.scheduledOn).dueOn = to;
      return;
    }
    case "set_actual_amount": {
      assertCents(change.amountCents, "change.amountCents");
      if (change.amountCents < 0) invalid("change.amountCents must not be negative");
      occurrenceRow(input, change.itemId, change.scheduledOn).actualAmountCents = change.amountCents;
      return;
    }
    case "split_planned_expense": {
      const p =
        input.plannedExpenses.find((x) => x.id === change.plannedExpenseId) ??
        invalid("change for an unknown planned expense");
      positiveCents(change.amountNowCents, "change.amountNowCents");
      if (change.amountNowCents >= p.amountCents) invalid("the first part must be less than the expense");
      input.plannedExpenses.push({
        ...p,
        id: `${p.id}:later`,
        amountCents: p.amountCents - change.amountNowCents,
        dueOn: parseDate(change.laterOn, "change.laterOn").toString(),
      });
      p.amountCents = change.amountNowCents;
      return;
    }
    case "add_transfer": {
      positiveCents(change.amountCents, "change.amountCents");
      const on = parseDate(change.on, "change.on").toString();
      if (change.fromGoalId != null) {
        const goal = findGoal(input, change.fromGoalId);
        if (change.amountCents > goal.savedCents) invalid("the transfer is more than the goal holds");
        goal.savedCents -= change.amountCents;
      }
      // A one-off inflow: a yearly schedule that starts and ends on the same day.
      input.items.push({
        id: `what-if:transfer:${index}`,
        name: "what_if_transfer",
        direction: "inflow",
        kind: "other",
        owner: "both",
        amount: { type: "fixed", cents: change.amountCents },
        schedule: { type: "yearly", dtstart: on, until: on },
        weekendRule: "none",
        paidFrom: "account",
        status: "active",
      });
      return;
    }
    case "set_item_amount": {
      assertCents(change.amountCents, "change.amountCents");
      if (change.amountCents < 0) invalid("change.amountCents must not be negative");
      findItem(input, change.itemId).amount = { type: "fixed", cents: change.amountCents };
      return;
    }
    case "set_goal_monthly": {
      assertCents(change.monthlyCents, "change.monthlyCents");
      if (change.monthlyCents < 0) invalid("change.monthlyCents must not be negative");
      findGoal(input, change.goalId).monthlyCents = change.monthlyCents;
      return;
    }
    default:
      invalid("unknown change type");
  }
}

/** Returns a new input with the changes applied in order. The caller's input is not modified. */
export function applyChanges(input: EngineInput, changes: readonly PlanChange[]): EngineInput {
  const next = copyInput(input);
  changes.forEach((c, i) => applyChange(next, c, i));
  return next;
}

/** What the hero shows: floored dollars when on track, minus the shortfall rounded up otherwise. */
function displayedSafeToSpend(plan: PlanResult): Cents {
  return plan.safeToSpendDisplayCents ?? -(plan.shortfallDisplayCents as Cents);
}

export function planDiff(before: PlanResult, after: PlanResult): PlanDiff {
  return {
    stateBefore: before.state,
    stateAfter: after.state,
    safeToSpendBeforeCents: before.safeToSpendCents,
    safeToSpendAfterCents: after.safeToSpendCents,
    deltaCents: after.safeToSpendCents - before.safeToSpendCents,
    changesSafeToSpend: displayedSafeToSpend(before) !== displayedSafeToSpend(after),
    lowestBefore: before.lowest,
    lowestAfter: after.lowest,
  };
}

/** Rule 9: the plan with the changes applied, and how safe to spend moved. */
export function whatIf(
  input: EngineInput,
  changes: readonly PlanChange[],
  base: PlanResult = computePlan(input),
): WhatIfResult {
  const changed = applyChanges(input, changes);
  const plan = computePlan(changed);
  return { input: changed, plan, diff: planDiff(base, plan) };
}
