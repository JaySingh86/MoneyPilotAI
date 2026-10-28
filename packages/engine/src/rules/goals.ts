// Rules 10 and 16: goal deposits, status and suggestions. One deposit per month, on the first primary
// payday of that month, starting with the next one on or after `asOf` (the same dates the runway uses for
// goal transfers).
import { compareDates, parseDate } from "../dates";
import type { PlainDate } from "../dates";
import { ceilToWholeDollars, divRoundHalfUp, sumCents } from "../money";
import { computePlan } from "../plan";
import type { Cents, EngineInput, GoalInput, IsoDate } from "../types";
import { primaryPaydays } from "../window";
import { applyChanges } from "./what-if";

/** How far ahead goal deposits are looked for. A goal that needs longer is `unreachable`. */
export const GOAL_HORIZON_YEARS = 50;

/** Deposit dates in order, lazily, up to the horizon. */
export function* goalDepositDates(input: EngineInput): Generator<PlainDate> {
  const from = parseDate(input.asOf, "asOf");
  let start = from.with({ day: 1 });
  for (let year = 0; year < GOAL_HORIZON_YEARS; year++) {
    const next = start.add({ months: 12 });
    let lastMonth = "";
    for (const d of primaryPaydays(input, start, next.subtract({ days: 1 }))) {
      const month = d.toPlainYearMonth().toString();
      if (month === lastMonth) continue;
      lastMonth = month;
      if (compareDates(d, from) >= 0) yield d;
    }
    start = next;
  }
}

/** The n-th deposit date (1-based), or null beyond the horizon. */
function nthDeposit(input: EngineInput, n: number): PlainDate | null {
  let i = 0;
  for (const d of goalDepositDates(input)) if (++i === n) return d;
  return null;
}

/** Deposits on or before `until`. */
function depositsUntil(input: EngineInput, until: PlainDate): number {
  let count = 0;
  for (const d of goalDepositDates(input)) {
    if (compareDates(d, until) > 0) break;
    count++;
  }
  return count;
}

/** Rule 10: ceil(remaining ÷ contributions) to whole dollars; null when no contribution is left. */
export function suggestMonthly(remainingCents: Cents, contributions: number): Cents | null {
  if (contributions <= 0) return null;
  if (remainingCents <= 0) return 0;
  return ceilToWholeDollars(Math.ceil(remainingCents / contributions));
}

export type GoalStatusKind =
  /** Saved ≥ target. */
  | "reached"
  /** No target date: reached in `reachMonth` at the current deposit (rule 16). */
  | "reach_month"
  /** No target date and no monthly deposit. */
  | "no_monthly_amount"
  /** No target date and the deposits never get there within the horizon. */
  | "unreachable"
  /** A target date the current deposits meet: "On track for {date}". */
  | "on_track"
  /** A savings goal short at its target date: "$X behind". */
  | "behind"
  /** A planned expense short at its date: "$X to set aside". */
  | "to_set_aside";

export interface GoalStatus {
  goalId: string;
  name: string;
  type: "savings" | "planned_expense";
  status: GoalStatusKind;
  /** Saved ÷ target, rounded half up, at most 100. */
  percent: number;
  savedCents: Cents;
  targetCents: Cents;
  remainingCents: Cents;
  monthlyCents: Cents;
  /** `YYYY-MM` of the deposit that reaches the target at the current amount; null if none. */
  reachMonth: string | null;
  targetDate: IsoDate | null;
  /** Deposits from the next one through the target date. Null without a target date. */
  contributionsByTarget: number | null;
  /** Saved plus those deposits (rule 10 "lower the target to the projected amount"). */
  projectedByTargetCents: Cents | null;
  /** Target − projected when short; null when on track or without a target date. */
  gapCents: Cents | null;
  /** Rule 10 "raise the monthly amount". Null without a target date or contributions. */
  suggestedMonthlyCents: Cents | null;
  /** Rule 10 "move the date to the first month that closes the gap at the current amount". */
  alternativeTargetDate: IsoDate | null;
}

function reachMonth(input: EngineInput, remainingCents: Cents, monthlyCents: Cents): string | null {
  if (monthlyCents <= 0) return null;
  const d = nthDeposit(input, Math.ceil(remainingCents / monthlyCents));
  return d === null ? null : d.toPlainYearMonth().toString();
}

/** The first date `target + k months` (k ≥ 1) on or after the deposit that closes the gap. */
function alternativeDate(
  input: EngineInput,
  target: PlainDate,
  remaining: Cents,
  monthly: Cents,
): IsoDate | null {
  if (monthly <= 0) return null;
  const closing = nthDeposit(input, Math.ceil(remaining / monthly));
  if (closing === null) return null;
  let k = 1;
  while (compareDates(target.add({ months: k }), closing) < 0) k++;
  return target.add({ months: k }).toString();
}

export function goalStatus(input: EngineInput, goal: GoalInput): GoalStatus {
  const type = goal.type ?? "savings";
  const monthly = goal.monthlyCents ?? 0;
  const remaining = Math.max(goal.targetCents - goal.savedCents, 0);
  // Rounding must not show 100% until the goal is reached.
  const percent =
    remaining === 0 ? 100 : Math.min(divRoundHalfUp(goal.savedCents * 100, goal.targetCents), 99);
  const base = {
    goalId: goal.id,
    name: goal.name,
    type,
    percent,
    savedCents: goal.savedCents,
    targetCents: goal.targetCents,
    remainingCents: remaining,
    monthlyCents: monthly,
    reachMonth: remaining > 0 ? reachMonth(input, remaining, monthly) : null,
    targetDate: goal.targetDate ?? null,
    contributionsByTarget: null,
    projectedByTargetCents: null,
    gapCents: null,
    suggestedMonthlyCents: null,
    alternativeTargetDate: null,
  };
  if (remaining === 0) return { ...base, status: "reached" };

  if (goal.targetDate == null) {
    if (monthly <= 0) return { ...base, status: "no_monthly_amount" };
    return { ...base, status: base.reachMonth === null ? "unreachable" : "reach_month" };
  }

  const target = parseDate(goal.targetDate, "goal.targetDate");
  const k = depositsUntil(input, target);
  const projected = goal.savedCents + k * monthly;
  const withTarget = {
    ...base,
    contributionsByTarget: k,
    projectedByTargetCents: projected,
    suggestedMonthlyCents: suggestMonthly(remaining, k),
  };
  if (projected >= goal.targetCents) return { ...withTarget, status: "on_track" };
  return {
    ...withTarget,
    status: type === "savings" ? "behind" : "to_set_aside",
    gapCents: goal.targetCents - projected,
    alternativeTargetDate: alternativeDate(input, target, remaining, monthly),
  };
}

export interface GoalsSummary {
  /** The sum of monthly deposits of goals not yet reached ("Saving each month"). */
  savingEachMonthCents: Cents;
  savedSoFarCents: Cents;
  /** Safe to spend with goal transfers minus without them (0 when they land on payday, after the window). */
  effectOnSafeToSpendCents: Cents;
  goals: GoalStatus[];
}

export function goalsSummary(input: EngineInput): GoalsSummary {
  const withGoals = computePlan(input).safeToSpendCents;
  const withoutGoals = computePlan(
    applyChanges(
      input,
      input.goals.map((g) => ({ type: "set_goal_monthly" as const, goalId: g.id, monthlyCents: 0 })),
    ),
  ).safeToSpendCents;
  return {
    savingEachMonthCents: sumCents(
      input.goals.filter((g) => g.savedCents < g.targetCents).map((g) => g.monthlyCents ?? 0),
    ),
    savedSoFarCents: sumCents(input.goals.map((g) => g.savedCents)),
    effectOnSafeToSpendCents: withGoals - withoutGoals,
    goals: input.goals.map((g) => goalStatus(input, g)),
  };
}
