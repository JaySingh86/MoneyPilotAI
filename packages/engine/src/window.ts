// Rule 1: the planning window runs from today through the next primary payday, inclusive. The payday is
// the next one strictly after today: on payday itself the window runs to the following payday, so safe to
// spend never spikes on payday (DESIGN_SPEC §6 rule 1, QUESTIONS.md Q-007).
import { compareDates, daysBetween, parseDate } from "./dates";
import type { PlainDate } from "./dates";
import { EngineError } from "./errors";
import { resolveOccurrences } from "./occurrences";
import type { EngineInput, PlanningWindow } from "./types";

/** How far ahead to look for the next primary payday (the materialized horizon, BACKEND_PLAN §7.1). */
const PAYDAY_HORIZON_DAYS = 400;

/** Primary-income due dates in [from, to], skipped ones excluded, ascending. */
export function primaryPaydays(input: EngineInput, from: PlainDate, to: PlainDate): PlainDate[] {
  return resolveOccurrences(input, from, to, (item) => item.id === input.primaryIncomeItemId)
    .filter(
      (o) => o.status !== "skipped" && compareDates(o.dueOn, from) >= 0 && compareDates(o.dueOn, to) <= 0,
    )
    .map((o) => o.dueOn);
}

export function planningWindowDates(input: EngineInput): { from: PlainDate; to: PlainDate } {
  const from = parseDate(input.asOf, "asOf");
  const [next] = primaryPaydays(input, from.add({ days: 1 }), from.add({ days: PAYDAY_HORIZON_DAYS }));
  if (!next) {
    throw new EngineError(
      "no_primary_income_occurrence",
      `no primary payday within ${PAYDAY_HORIZON_DAYS} days`,
    );
  }
  return { from, to: next };
}

/** Rule 1. `daysToPayday` (always ≥ 1) counts calendar days, so DST changes never affect it. */
export function planningWindow(input: EngineInput): PlanningWindow {
  const { from, to } = planningWindowDates(input);
  return { from: from.toString(), to: to.toString(), daysToPayday: daysBetween(from, to) };
}
