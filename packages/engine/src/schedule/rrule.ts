// Schedule union ↔ RFC 5545 RRULE + DTSTART (BACKEND_PLAN §7.1, ADR-006).
//
// The DB stores `rrule`, `dtstart` and `until` in separate columns, so the RRULE string carries neither
// DTSTART nor UNTIL. Days that some months lack (29–31, or Feb 29 yearly) use
// `BYMONTHDAY=d,-1;BYSETPOS=1`, which RFC 5545 evaluates to "day d, or the last day if the month is
// shorter" — the same month-end clamp as `expandSchedule` (QUESTIONS.md Q-004).
import { WEEKDAYS, parseDate, weekdayOf } from "../dates";
import type { PlainDate } from "../dates";
import { EngineError } from "../errors";
import { expandSchedule, validateSchedule } from "./expand";
import type { IsoDate, Schedule, Weekday } from "./types";

export interface RRuleParts {
  /** Without the `RRULE:` prefix, e.g. `FREQ=MONTHLY;BYMONTHDAY=1`. */
  rrule: string;
  dtstart: IsoDate;
  until: IsoDate | null;
}

const BYDAY_CODE: Record<Weekday, string> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};
const WEEKDAY_BY_CODE = new Map<string, Weekday>(WEEKDAYS.map((w) => [BYDAY_CODE[w], w]));

function monthDayRule(day: number): string {
  return day >= 29 ? `BYMONTHDAY=${day},-1;BYSETPOS=1` : `BYMONTHDAY=${day}`;
}

/** Converts a Schedule to the RRULE stored in `recurring_items.rrule`. */
export function scheduleToRRule(schedule: Schedule): RRuleParts {
  validateSchedule(schedule);
  const start = parseDate(schedule.dtstart, "dtstart");
  let rrule: string;
  switch (schedule.type) {
    case "monthly_day":
      rrule = `FREQ=MONTHLY;${monthDayRule(schedule.day)}`;
      break;
    case "monthly_last_day":
      rrule = "FREQ=MONTHLY;BYMONTHDAY=-1";
      break;
    case "monthly_last_weekday":
      rrule = `FREQ=MONTHLY;BYDAY=-1${BYDAY_CODE[schedule.weekday]}`;
      break;
    case "every_n_weeks":
      rrule =
        schedule.n === 1
          ? `FREQ=WEEKLY;BYDAY=${BYDAY_CODE[weekdayOf(start)]}`
          : `FREQ=WEEKLY;INTERVAL=${schedule.n};BYDAY=${BYDAY_CODE[weekdayOf(start)]}`;
      break;
    case "every_n_months":
      rrule = `FREQ=MONTHLY;INTERVAL=${schedule.n};${monthDayRule(start.day)}`;
      break;
    case "yearly": {
      const day =
        start.month === 2 && start.day === 29 ? "BYMONTHDAY=29,-1;BYSETPOS=1" : `BYMONTHDAY=${start.day}`;
      rrule = `FREQ=YEARLY;BYMONTH=${start.month};${day}`;
      break;
    }
  }
  return { rrule, dtstart: firstOccurrence(schedule, start).toString(), until: schedule.until ?? null };
}

/**
 * RFC 5545 makes DTSTART the first instance, so it must be a real occurrence. Anchored schedules
 * (`every_n_weeks`, `every_n_months`, `yearly`) take their cadence from `dtstart`, so it already is one;
 * the monthly schedules treat `dtstart` as a lower bound, so it is snapped to the first date on or after it.
 */
function firstOccurrence(schedule: Schedule, start: PlainDate): PlainDate {
  // The widest gap between occurrences is 12 months (yearly), so 13 months always finds one.
  const [first] = expandSchedule(schedule, start, start.add({ months: 13 }));
  if (!first) throw new EngineError("invalid_schedule", "the schedule has no occurrence before until");
  return first;
}

function invalid(detail: string): never {
  throw new EngineError("invalid_rrule", detail);
}

const ALLOWED_KEYS = new Set([
  "FREQ",
  "INTERVAL",
  "BYMONTHDAY",
  "BYDAY",
  "BYMONTH",
  "BYSETPOS",
  "UNTIL",
  "WKST",
]);

function parseParts(rrule: string): Map<string, string> {
  const body = rrule.trim().replace(/^RRULE:/i, "");
  if (body.length === 0) invalid("empty RRULE");
  const parts = new Map<string, string>();
  for (const pair of body.split(";")) {
    const [rawKey, value, extra] = pair.split("=");
    const key = rawKey?.trim().toUpperCase();
    if (!key || value === undefined || extra !== undefined || value.trim() === "") invalid("malformed part");
    if (!ALLOWED_KEYS.has(key)) invalid(`unsupported part ${key}`);
    if (parts.has(key)) invalid(`duplicate part ${key}`);
    parts.set(key, value.trim().toUpperCase());
  }
  return parts;
}

function parsePositiveInt(value: string, what: string): number {
  if (!/^\d+$/.test(value)) invalid(`${what} must be a positive integer`);
  const n = Number(value);
  if (n < 1) invalid(`${what} must be a positive integer`);
  return n;
}

function parseUntil(value: string): IsoDate {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) invalid("UNTIL must be a date (YYYYMMDD)");
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  try {
    parseDate(iso, "UNTIL");
  } catch {
    invalid("UNTIL is not a real date");
  }
  return iso;
}

/** Parses BYMONTHDAY (+ BYSETPOS) into a day 1–31, or `last`. */
function parseMonthDay(parts: Map<string, string>): number | "last" | null {
  const byMonthDay = parts.get("BYMONTHDAY");
  const bySetPos = parts.get("BYSETPOS");
  if (byMonthDay === undefined) {
    if (bySetPos !== undefined) invalid("BYSETPOS needs BYMONTHDAY");
    return null;
  }
  if (byMonthDay === "-1") {
    if (bySetPos !== undefined) invalid("unexpected BYSETPOS");
    return "last";
  }
  const clamp = /^(29|30|31),-1$/.exec(byMonthDay);
  if (clamp) {
    if (bySetPos !== "1") invalid("a month-end clamp needs BYSETPOS=1");
    return Number(clamp[1]);
  }
  if (bySetPos !== undefined) invalid("unexpected BYSETPOS");
  const day = parsePositiveInt(byMonthDay, "BYMONTHDAY");
  if (day > 31) invalid("BYMONTHDAY out of range");
  // A bare 29–31 would skip short months under RFC 5545; we only accept the clamped form.
  if (day >= 29) invalid("days 29–31 must use the clamped form BYMONTHDAY=d,-1;BYSETPOS=1");
  return day;
}

/** Converts a stored RRULE + DTSTART (+ UNTIL) back to a Schedule. Rejects anything the union can't express. */
export function scheduleFromRRule(input: {
  rrule: string;
  dtstart: IsoDate;
  until?: IsoDate | null;
}): Schedule {
  const start = parseDate(input.dtstart, "dtstart");
  const parts = parseParts(input.rrule);
  const wkst = parts.get("WKST");
  if (wkst !== undefined && wkst !== "MO") invalid("only WKST=MO is supported");

  let until: IsoDate | null = input.until ?? null;
  const ruleUntil = parts.get("UNTIL");
  if (ruleUntil !== undefined) {
    const parsed = parseUntil(ruleUntil);
    if (until !== null && until !== parsed) invalid("UNTIL disagrees with the until column");
    until = parsed;
  }
  const bounds = { dtstart: input.dtstart, ...(until !== null ? { until } : {}) };

  const freq = parts.get("FREQ");
  const intervalRaw = parts.get("INTERVAL");
  const interval = intervalRaw === undefined ? 1 : parsePositiveInt(intervalRaw, "INTERVAL");
  const byDay = parts.get("BYDAY");
  const byMonth = parts.get("BYMONTH");

  let schedule: Schedule;
  switch (freq) {
    case "MONTHLY": {
      if (byMonth !== undefined) invalid("BYMONTH is not supported with FREQ=MONTHLY");
      if (byDay !== undefined) {
        const m = /^-1(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay);
        if (!m || interval !== 1 || parts.has("BYMONTHDAY") || parts.has("BYSETPOS")) {
          invalid("only BYDAY=-1XX (last weekday) is supported monthly");
        }
        schedule = {
          type: "monthly_last_weekday",
          weekday: WEEKDAY_BY_CODE.get(m[1] ?? "") as Weekday,
          ...bounds,
        };
        break;
      }
      const day = parseMonthDay(parts);
      if (interval > 1) {
        // every_n_months: the day comes from DTSTART. INTERVAL=1 is plain monthly (below).
        if (day === "last") invalid("an interval with BYMONTHDAY=-1 is not supported");
        if (day !== null && day !== start.day) invalid("BYMONTHDAY must match the DTSTART day");
        schedule = { type: "every_n_months", n: interval, ...bounds };
      } else if (day === "last") {
        schedule = { type: "monthly_last_day", ...bounds };
      } else {
        schedule = { type: "monthly_day", day: day ?? start.day, ...bounds };
      }
      break;
    }
    case "WEEKLY": {
      if (byMonth !== undefined || parts.has("BYMONTHDAY") || parts.has("BYSETPOS")) {
        invalid("unsupported part with FREQ=WEEKLY");
      }
      if (byDay !== undefined && WEEKDAY_BY_CODE.get(byDay) !== weekdayOf(start)) {
        invalid("BYDAY must be the single weekday of DTSTART");
      }
      schedule = { type: "every_n_weeks", n: interval, ...bounds };
      break;
    }
    case "YEARLY": {
      if (interval !== 1 || byDay !== undefined) invalid("only plain yearly rules are supported");
      if (byMonth !== undefined && Number(byMonth) !== start.month) invalid("BYMONTH must match DTSTART");
      if (!parts.has("BYMONTHDAY") && parts.has("BYSETPOS")) invalid("unexpected BYSETPOS");
      const day = parts.has("BYMONTHDAY") ? parseYearlyDay(parts, start.month) : start.day;
      if (day !== start.day) invalid("BYMONTHDAY must match DTSTART");
      schedule = { type: "yearly", ...bounds };
      break;
    }
    default:
      invalid("FREQ must be MONTHLY, WEEKLY or YEARLY");
  }
  validateSchedule(schedule);
  return schedule;
}

/** Yearly BYMONTHDAY: a plain day, or `29,-1;BYSETPOS=1` for a Feb 29 anchor (a bare 29 would skip 3 years in 4). */
function parseYearlyDay(parts: Map<string, string>, month: number): number {
  const byMonthDay = parts.get("BYMONTHDAY") ?? "";
  const bySetPos = parts.get("BYSETPOS");
  if (byMonthDay === "29,-1") {
    if (month !== 2 || bySetPos !== "1") invalid("the clamped form is only for Feb 29 with BYSETPOS=1");
    return 29;
  }
  if (bySetPos !== undefined) invalid("unexpected BYSETPOS");
  const day = parsePositiveInt(byMonthDay, "BYMONTHDAY");
  if (month === 2 && day === 29) invalid("Feb 29 must use the clamped form BYMONTHDAY=29,-1;BYSETPOS=1");
  return day;
}
