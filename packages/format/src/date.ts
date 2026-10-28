// Date formatting per DESIGN_SPEC §7. Bill dates are household-local PlainDates (hard rule 2).
// There is no clock here: "the current year" comes from the caller's `relativeTo` date.
import type { Temporal } from "@js-temporal/polyfill";

const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
// Temporal dayOfWeek: 1 = Monday … 7 = Sunday.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The fields this module reads; any Temporal.PlainDate satisfies it. */
export type PlainDateLike = Pick<Temporal.PlainDate, "year" | "month" | "day" | "dayOfWeek">;

export interface DateOptions {
  /** Household-local today. Dates in its year omit the year. */
  relativeTo: Pick<Temporal.PlainDate, "year">;
  /** Prefix the short weekday where timing matters: `Wed, Nov 4`. */
  weekday?: boolean;
  /** `long` spells the month out for screen-reader labels: `November 4`. Default `short`. */
  month?: "short" | "long";
}

/**
 * `Nov 4` in the current year, otherwise `Jan 9, 2027`; with `weekday`, `Wed, Nov 4`.
 */
export function date(value: PlainDateLike, options: DateOptions): string {
  const month = (options.month === "long" ? LONG_MONTHS : MONTHS)[value.month - 1];
  const weekday = WEEKDAYS[value.dayOfWeek - 1];
  if (month === undefined || weekday === undefined) {
    throw new RangeError("Not a valid ISO calendar date.");
  }
  const base = `${month} ${value.day}`;
  const withYear = value.year === options.relativeTo.year ? base : `${base}, ${value.year}`;
  return options.weekday ? `${weekday}, ${withYear}` : withYear;
}

/**
 * Secondary relative time for a day offset from today: `in 8 days`, `tomorrow`, `today`,
 * `yesterday`, `3 days ago`. Compute `days` with `today.until(date).days`.
 */
export function relative(days: number): string {
  if (!Number.isSafeInteger(days)) {
    throw new TypeError("days must be an integer.");
  }
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** The short weekday alone: `Wed`. */
export function weekday(value: PlainDateLike): string {
  const name = WEEKDAYS[value.dayOfWeek - 1];
  if (name === undefined) throw new RangeError("Not a valid ISO weekday.");
  return name;
}
