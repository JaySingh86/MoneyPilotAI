// Calendar helpers on Temporal.PlainDate (hard rule 2, ADR-007). No Date, no clock.
import { Temporal } from "@js-temporal/polyfill";
import { EngineError } from "./errors";
import type { IsoDate, Weekday } from "./schedule/types";

export { Temporal };
export type PlainDate = Temporal.PlainDate;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a strict `YYYY-MM-DD` household-local date. Rejects times, offsets and impossible dates. */
export function parseDate(value: string, field = "date"): PlainDate {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new EngineError("invalid_date", `${field} must be YYYY-MM-DD`);
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    throw new EngineError("invalid_date", `${field} is not a real calendar date`);
  }
}

export function toIso(date: PlainDate): IsoDate {
  return date.toString();
}

export function compareDates(a: PlainDate, b: PlainDate): number {
  return Temporal.PlainDate.compare(a, b);
}

/** Locale-independent string order, for deterministic tie-breaks. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: PlainDate, b: PlainDate): PlainDate {
  return compareDates(a, b) <= 0 ? a : b;
}

export function maxDate(a: PlainDate, b: PlainDate): PlainDate {
  return compareDates(a, b) >= 0 ? a : b;
}

/** Whole calendar days from `a` to `b` (negative if `b` is earlier). DST never changes this. */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  return a.until(b, { largestUnit: "days" }).days;
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: PlainDate, to: PlainDate): PlainDate[] {
  const out: PlainDate[] = [];
  for (let d = from; compareDates(d, to) <= 0; d = d.add({ days: 1 })) out.push(d);
  return out;
}

export const WEEKDAYS: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** ISO weekday number, Monday = 1 … Sunday = 7 (Temporal's `dayOfWeek`). */
export function weekdayNumber(weekday: Weekday): number {
  return WEEKDAYS.indexOf(weekday) + 1;
}

export function weekdayOf(date: PlainDate): Weekday {
  const w = WEEKDAYS[date.dayOfWeek - 1];
  if (!w) throw new EngineError("invalid_date", "weekday out of range");
  return w;
}

/** Throws unless `timezone` is a valid IANA zone. */
export function assertTimeZone(timezone: string): string {
  try {
    if (typeof timezone !== "string" || timezone.length === 0) throw new RangeError("empty");
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone).timeZoneId;
  } catch {
    throw new EngineError("invalid_timezone", "timezone must be an IANA zone name");
  }
}

/**
 * The household-local calendar date of a UTC instant (e.g. the server's request time).
 * The caller supplies the instant; the engine never reads a clock.
 */
export function householdDate(instant: string, timezone: string): IsoDate {
  assertTimeZone(timezone);
  let parsed: Temporal.Instant;
  try {
    parsed = Temporal.Instant.from(instant);
  } catch {
    throw new EngineError("invalid_date", "instant must be an ISO 8601 timestamp with an offset");
  }
  return parsed.toZonedDateTimeISO(timezone).toPlainDate().toString();
}
