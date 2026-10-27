// computePlan: DESIGN_SPEC §6 rules 1–5 and 7 on one EngineInput (BACKEND_PLAN §7.2).
import { billsBeforePaydayDates } from "./bills-before-payday";
import { daysBetween, parseDate } from "./dates";
import { mathLines } from "./math-lines";
import { projectRunwayDates } from "./runway";
import { belowCushionFrom, belowZeroDates, lowestPoint, perDay, safeToSpend } from "./safe-to-spend";
import type { BillsBeforePayday, EngineInput, Flag, PlanResult, PlanningWindow, Runway } from "./types";
import { validateInput } from "./validate";
import { ENGINE_VERSION } from "./version";
import { planningWindowDates } from "./window";

/** A balance more than this many days older than `asOf` raises `stale_balance` (BACKEND_PLAN §7.2). */
export const STALE_BALANCE_DAYS = 7;

function windowDates(window: PlanningWindow) {
  return { from: parseDate(window.from, "window.from"), to: parseDate(window.to, "window.to") };
}

/** Rules 2 and 7 for a window (defaults to the planning window). */
export function projectRunway(input: EngineInput, window?: PlanningWindow): Runway {
  validateInput(input);
  const { from, to } = window ? windowDates(window) : planningWindowDates(input);
  return projectRunwayDates(input, from, to);
}

/** Money out due from the window start up to, not including, the payday. */
export function billsBeforePayday(input: EngineInput, window?: PlanningWindow): BillsBeforePayday {
  validateInput(input);
  const { from, to } = window ? windowDates(window) : planningWindowDates(input);
  return billsBeforePaydayDates(input, from, to);
}

export function staleBalanceFlags(input: EngineInput): Flag[] {
  const age = daysBetween(parseDate(input.startingBalance.asOf), parseDate(input.asOf));
  return age > STALE_BALANCE_DAYS
    ? [{ code: "stale_balance", subjectId: null, date: input.startingBalance.asOf }]
    : [];
}

/** The full core plan. Pure: the same input always gives the same output. */
export function computePlan(input: EngineInput): PlanResult {
  validateInput(input);
  const { from, to } = planningWindowDates(input);
  const window: PlanningWindow = {
    from: from.toString(),
    to: to.toString(),
    daysToPayday: daysBetween(from, to),
  };
  const runway = projectRunwayDates(input, from, to);
  const lowest = lowestPoint(runway.days);
  const safe = safeToSpend(lowest.balanceCents, input.cushionCents);
  const perDayCents = perDay(safe.safeToSpendCents, window.daysToPayday);
  const { days, ...runwayDetail } = runway;

  return {
    engineVersion: ENGINE_VERSION,
    asOf: window.from,
    window,
    runway: days,
    runwayDetail,
    lowest,
    state: safe.state,
    safeToSpendCents: safe.safeToSpendCents,
    safeToSpendDisplayCents: safe.safeToSpendDisplayCents,
    shortfallDisplayCents: safe.shortfallDisplayCents,
    perDayCents,
    belowCushionFrom: belowCushionFrom(days, input.cushionCents),
    belowZeroDates: belowZeroDates(days),
    billsBeforePayday: billsBeforePaydayDates(input, from, to),
    flags: staleBalanceFlags(input),
    math: mathLines({ runway, window, lowest, cushionCents: input.cushionCents, safe, perDayCents }),
  };
}
