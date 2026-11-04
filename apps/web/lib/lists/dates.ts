// Calendar helpers for the list screens. "Today" is `asOf` from the plan, never the clock (hard rule 2).
import { Temporal } from "@js-temporal/polyfill";
import { relative } from "@mp/format";

/** Whole days from `today` to `iso` (negative when past). */
export function daysFrom(today: string, iso: string): number {
  return Temporal.PlainDate.from(today).until(Temporal.PlainDate.from(iso), { largestUnit: "day" }).days;
}

/** Secondary relative time: "in 8 days", "tomorrow" (DESIGN_SPEC §7). */
export function relativeFrom(today: string, iso: string): string {
  return relative(daysFrom(today, iso));
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export function weekdayLong(iso: string): string {
  return WEEKDAYS[Temporal.PlainDate.from(iso).dayOfWeek - 1] ?? "";
}

export function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "Electricity and credit card": the first name as is, the rest lower-cased. */
export function nameList(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return "";
  const all = [first, ...rest.map((n) => n.charAt(0).toLowerCase() + n.slice(1))];
  return all.length === 1 ? first : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}
