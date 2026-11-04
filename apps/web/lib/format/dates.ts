// Calendar-date helpers for the screens. Bill dates are household-local `PlainDate`s (hard rule 2);
// nothing here reads the clock: "today" is `asOf` from the API. Short dates ("Nov 4", "Wed, Nov 4")
// come from @mp/format; the longer forms the canvas uses in headings are written out here because
// @mp/format has no long-weekday or month-title form.
import { date as formatDate } from "@mp/format";
import { Temporal } from "@js-temporal/polyfill";

export type PlainDate = Temporal.PlainDate;

export function parseDate(iso: string): PlainDate {
  return Temporal.PlainDate.from(iso);
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTHS = [
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

/** "Nov 4" in the year of `today`, otherwise "Jan 9, 2027" (DESIGN_SPEC §7). */
export function shortDate(iso: string, today: string, options: { weekday?: boolean } = {}): string {
  return formatDate(parseDate(iso), { relativeTo: parseDate(today), weekday: options.weekday });
}

/** "Nov 4" whatever the year: for headings that are always about the current window ("through Friday, Nov 6"). */
export function shortDateNoYear(iso: string): string {
  const d = parseDate(iso);
  return formatDate(d, { relativeTo: d });
}

/** "Oct 26, 2026": always with the year, as the canvas footer draws it. */
export function shortDateWithYear(iso: string): string {
  const d = parseDate(iso);
  return formatDate(d, { relativeTo: { year: d.year - 1 } });
}

/** "Tuesday, October 27" for the page overline. */
export function overlineDate(iso: string): string {
  const d = parseDate(iso);
  return `${WEEKDAYS[d.dayOfWeek - 1]}, ${MONTHS[d.month - 1]} ${d.day}`;
}

/** "Friday, Nov 6" for the page subtitle. */
export function longWeekdayShortDate(iso: string): string {
  const d = parseDate(iso);
  return `${WEEKDAYS[d.dayOfWeek - 1]}, ${shortDateNoYear(iso)}`;
}

/** "Wed" . */
export function weekdayName(iso: string): string {
  return WEEKDAYS[parseDate(iso).dayOfWeek - 1]?.slice(0, 3) ?? "";
}

/** "Wednesday, Nov 4" for the calendar side panel. */
export function selectedDayTitle(iso: string): string {
  return longWeekdayShortDate(iso);
}

/** "2026-11" → "November 2026". */
export function monthTitle(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-11" → "November". */
export function monthName(yearMonth: string): string {
  const [, m] = yearMonth.split("-").map(Number) as [number, number];
  return MONTHS[m - 1] ?? "";
}

/** "2027-10" → "Oct 2027". */
export function monthYear(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  return `${(MONTHS[m - 1] ?? "").slice(0, 3)} ${y}`;
}

/** "2026-11-04" → "2026-11". */
export function yearMonthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Moves a `YYYY-MM` by whole months. */
export function addMonths(yearMonth: string, months: number): string {
  return Temporal.PlainYearMonth.from(yearMonth).add({ months }).toString();
}
