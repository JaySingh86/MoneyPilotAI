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
