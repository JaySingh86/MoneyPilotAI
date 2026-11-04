// Sentences assembled from engine results (hard rule 4: the dates and amounts are the engine's).
import { parseDate, shortDate } from "./dates";

/** "Nov 4" for one date, "Nov 4–5" for a run in one month, "Nov 30–Dec 2" across months. */
export function dateRange(dates: readonly string[], today: string): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return "";
  if (first === last) return shortDate(first, today);
  const a = parseDate(first);
  const b = parseDate(last);
  return a.month === b.month && a.year === b.year
    ? `${shortDate(first, today)}–${b.day}`
    : `${shortDate(first, today)}–${shortDate(last, today)}`;
}

/** The hero caption in a shortfall: "Below your cushion from Nov 3, below $0 on Nov 4–5". */
export function shortfallCaption(plan: {
  asOf: string;
  belowCushionFrom: string | null;
  belowZeroDates: readonly string[];
}): string {
  const parts: string[] = [];
  if (plan.belowCushionFrom)
    parts.push(`Below your cushion from ${shortDate(plan.belowCushionFrom, plan.asOf)}`);
  if (plan.belowZeroDates.length > 0) parts.push(`below $0 on ${dateRange(plan.belowZeroDates, plan.asOf)}`);
  return parts.join(", ");
}

/** "1 item" / "3 items". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
