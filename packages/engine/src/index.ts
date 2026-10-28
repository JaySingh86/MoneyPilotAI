// @mp/engine: pure planning math (DESIGN_SPEC §6, BACKEND_PLAN §7.2). No I/O, no clock, no randomness.
// WP-02: rules 1–5 and 7, schedules. WP-07 adds the remaining rules under src/rules/.

export * from "./types";
export { ENGINE_VERSION } from "./version";
export { EngineError } from "./errors";
export type { EngineErrorCode } from "./errors";

// Plan
export { computePlan, projectRunway, billsBeforePayday, staleBalanceFlags, STALE_BALANCE_DAYS } from "./plan";
export { planningWindow } from "./window";
export {
  lowestPoint,
  safeToSpend,
  perDay,
  belowCushionFrom,
  belowZeroDates,
  daysBeforePayday,
  PER_DAY_STEP_CENTS,
} from "./safe-to-spend";
export type { SafeToSpend } from "./safe-to-spend";
export { mathLines } from "./math-lines";
export { validateInput } from "./validate";
export { itemAmount } from "./occurrences";

// Rules (WP-07): DESIGN_SPEC §5.3, §6 rules 6, 8–17
export { computeFullPlan } from "./rules/full-plan";
export { estimate, estimateRange, ESTIMATE_RANGE_STEP_CENTS, ESTIMATE_HISTORY_SIZE } from "./rules/estimate";
export type { Estimate } from "./rules/estimate";
export { flags, ruleFlags, sortFlags, isInfrequent, FLAG_ORDER } from "./rules/flags";
export {
  isPriceUp,
  priceUpShowing,
  PRICE_UP_MIN_CENTS,
  PRICE_UP_MIN_PERCENT,
  PRICE_UP_SHOW_DAYS,
} from "./rules/price";
export { decisions, DECISION_ORDER, DECIDE_THIS_WEEK_DAYS } from "./rules/decisions";
export { whatIf, applyChanges, planDiff } from "./rules/what-if";
export {
  shortfallOptions,
  optionResult,
  isMovable,
  SHORTFALL_TARGET_PER_DAY_CENTS,
  FUND_MOVE_STEP_CENTS,
} from "./rules/shortfall";
export {
  goalStatus,
  goalsSummary,
  suggestMonthly,
  goalDepositDates,
  GOAL_HORIZON_YEARS,
} from "./rules/goals";
export type { GoalStatus, GoalStatusKind, GoalsSummary } from "./rules/goals";
export {
  renewalsSummary,
  renewalList,
  renewalRow,
  annualCents,
  nextRenewal,
  isBigRenewal,
  actBy,
  BIG_RENEWAL_WINDOW_DAYS,
  BIG_RENEWAL_MIN_MONTHS,
  SHOP_AROUND_DAYS,
  BIG_RENEWAL_REMINDER_OFFSETS,
} from "./rules/renewals";
export type { RenewalRow, RenewalsSummary } from "./rules/renewals";
export { billsAverages, monthlyAverageCents } from "./rules/bills-averages";
export type { BillsAverages } from "./rules/bills-averages";
export { calendarMonth, DECISION_FLAG_CODES } from "./rules/calendar";
export type {
  CalendarMonth,
  CalendarDay,
  CalendarEntry,
  CalendarEntryKind,
  CalendarMonthSummary,
} from "./rules/calendar";
export { tasksDueThisWeek, DUE_THIS_WEEK_DAYS } from "./rules/tasks";
export type { TaskGroups } from "./rules/tasks";
export { ownerMatches } from "./rules/owners";

// Schedules
export { expandSchedule, validateSchedule } from "./schedule/expand";
export { scheduleToRRule, scheduleFromRRule } from "./schedule/rrule";
export type { RRuleParts } from "./schedule/rrule";
export { applyWeekendRule } from "./schedule/weekend";
export {
  US_FEDERAL_HOLIDAYS,
  HOLIDAY_TABLE_FIRST_YEAR,
  HOLIDAY_TABLE_LAST_YEAR,
  isUsFederalHoliday,
  isBusinessDay,
  isWeekend,
} from "./schedule/holidays";

// Dates and money
export { householdDate, parseDate, daysBetween } from "./dates";
export {
  assertCents,
  floorToWholeDollars,
  ceilToWholeDollars,
  floorToMultiple,
  ceilToMultiple,
  divRoundHalfUp,
} from "./money";
