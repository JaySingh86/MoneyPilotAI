// Recurring detection (BACKEND_PLAN §7.7 step 5). Pure: transactions in, candidates out.
//
//   group      by merchant_norm and sign, over the last 13 months (same-day rows collapse to one occurrence)
//   cadence    from the median interval: weekly 7±1, biweekly 14±2, monthly 28-33, every 2 months 56-65,
//              quarterly 85-96, every 6 months 175-190, yearly 355-375. At least 70% of the intervals must sit in
//              the band, so a merchant visited at random is not a bill. A weekday that is always the LAST of its
//              month (a "last Friday" paycheck) alternates 28 and 35 days, so it is recognised as monthly first.
//   amount     coefficient of variation under 10% means `fixed`, otherwise `estimated` (computed in exact integer
//              arithmetic: 100 * (n*sum(x^2) - sum(x)^2) < sum(x)^2, population variance)
//   paychecks  inflows
// Amounts in a candidate are positive cents; `direction` says which way the money moves. The amount shown for a
// fixed item is the most recent one (a price change moves it); for an estimated item `typicalAmountCents` is the
// median and only a hint: the engine owns every number users see (hard rule 4).
import {
  addDays,
  addMonthsClamped,
  daysBetween,
  endOfMonth,
  isLastDayOfMonth,
  isLastWeekdayOfMonth,
  lastWeekdayOfMonth,
  plain,
  weekdayOf,
  withDayClamped,
} from "./dates";
import { displayName } from "./merchant";

export const CADENCES = [
  "weekly",
  "biweekly",
  "monthly",
  "every_2_months",
  "quarterly",
  "every_6_months",
  "yearly",
] as const;
export type Cadence = (typeof CADENCES)[number];

interface Band {
  cadence: Cadence;
  lo: number;
  hi: number;
  months: number;
  minOccurrences: number;
}

const BANDS: readonly Band[] = [
  { cadence: "weekly", lo: 6, hi: 8, months: 0, minOccurrences: 4 },
  { cadence: "biweekly", lo: 12, hi: 16, months: 0, minOccurrences: 3 },
  { cadence: "monthly", lo: 28, hi: 33, months: 1, minOccurrences: 3 },
  { cadence: "every_2_months", lo: 56, hi: 65, months: 2, minOccurrences: 3 },
  { cadence: "quarterly", lo: 85, hi: 96, months: 3, minOccurrences: 3 },
  // Two hits are enough here: a yearly item needs one prior hit, a six-monthly one fits twice in 13 months.
  { cadence: "every_6_months", lo: 175, hi: 190, months: 6, minOccurrences: 2 },
  { cadence: "yearly", lo: 355, hi: 375, months: 12, minOccurrences: 2 },
];

export const WINDOW_MONTHS = 13;
/** The first day of the 13-month window that ends on `asOf` (also the retention cut-off for stored transactions). */
export function windowStart(asOf: string): string {
  return addMonthsClamped(asOf, -WINDOW_MONTHS);
}

const MIN_REGULAR_SHARE_PERCENT = 70;
const FIXED_CV_PERCENT = 10;
const PAYROLL = /\b(payroll|direct dep|dir dep|salary|paycheck|pay ck|wages)\b/;

export type AmountType = "fixed" | "estimated";

export type ScheduleHint =
  | { kind: "weekly" | "biweekly"; weekday: number }
  | { kind: "monthly_day"; day: number }
  | { kind: "monthly_last_day" }
  | { kind: "monthly_last_weekday"; weekday: number }
  | { kind: "every_n_months"; n: 2 | 3 | 6; day: number; lastDay: boolean }
  | { kind: "yearly"; month: number; day: number };

export interface DetectTransaction {
  postedOn: string;
  merchantNorm: string;
  /** Negative = outflow. */
  amountCents: number;
  description: string;
}

export interface RecurringCandidate {
  /** Stable across imports: `outflow:rent`. The worker uses it so a re-run does not queue the same item twice. */
  key: string;
  merchantNorm: string;
  displayName: string;
  direction: "inflow" | "outflow";
  kind: "paycheck" | "recurring";
  cadence: Cadence;
  schedule: ScheduleHint;
  amountType: AmountType;
  /** The most recent amount, positive cents. */
  amountCents: number;
  /** The median amount, positive cents. */
  typicalAmountCents: number;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  /** The next date on or after `asOf` that the schedule predicts. */
  nextExpected: string;
  /** The sanitized description of the latest transaction (evidence for the review card). */
  latestDescription: string;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return hi;
  return Math.floor(((sorted[mid - 1] ?? 0) + hi) / 2);
}

/** CV < 10% in exact integer arithmetic. */
export function classifyAmounts(amountsCents: readonly number[]): AmountType {
  const n = BigInt(amountsCents.length);
  let sum = 0n;
  let sumSq = 0n;
  for (const a of amountsCents) {
    const x = BigInt(Math.abs(a));
    sum += x;
    sumSq += x * x;
  }
  const scaledVariance = n * sumSq - sum * sum; // n^2 * variance
  return BigInt(100 * 100) * scaledVariance < BigInt(FIXED_CV_PERCENT * FIXED_CV_PERCENT) * sum * sum
    ? "fixed"
    : "estimated";
}

function bandFor(medianGap: number): Band | undefined {
  return BANDS.find((b) => medianGap >= b.lo && medianGap <= b.hi);
}

function scheduleFor(band: Band, dates: readonly string[], lastWeekdayPattern: boolean): ScheduleHint {
  const last = dates[dates.length - 1] ?? "";
  if (band.cadence === "weekly" || band.cadence === "biweekly") {
    return { kind: band.cadence, weekday: weekdayOf(last) };
  }
  if (band.cadence === "monthly" && lastWeekdayPattern) {
    return { kind: "monthly_last_weekday", weekday: weekdayOf(last) };
  }
  if (band.cadence === "yearly") {
    const d = plain(last);
    return { kind: "yearly", month: d.month, day: d.day };
  }
  const days = dates.map((d) => plain(d).day);
  const lastDayShare = (dates.filter(isLastDayOfMonth).length * 100) / dates.length;
  const lastDay = lastDayShare >= MIN_REGULAR_SHARE_PERCENT;
  if (band.cadence === "monthly") {
    return lastDay ? { kind: "monthly_last_day" } : { kind: "monthly_day", day: median(days) };
  }
  return { kind: "every_n_months", n: band.months as 2 | 3 | 6, day: median(days), lastDay };
}

export function nextExpected(
  cadence: Cadence,
  schedule: ScheduleHint,
  lastSeen: string,
  asOf: string,
): string {
  const band = BANDS.find((b) => b.cadence === cadence);
  if (!band) return asOf;
  let cursor = lastSeen;
  for (let guard = 0; guard < 600; guard++) {
    if (band.months === 0) cursor = addDays(cursor, cadence === "weekly" ? 7 : 14);
    else {
      const moved = addMonthsClamped(withDayClamped(cursor, 1), band.months);
      switch (schedule.kind) {
        case "monthly_last_day":
          cursor = endOfMonth(moved);
          break;
        case "monthly_last_weekday":
          cursor = lastWeekdayOfMonth(moved, schedule.weekday);
          break;
        case "every_n_months":
          cursor = schedule.lastDay ? endOfMonth(moved) : withDayClamped(moved, schedule.day);
          break;
        case "monthly_day":
          cursor = withDayClamped(moved, schedule.day);
          break;
        case "yearly":
          cursor = withDayClamped(moved, schedule.day);
          break;
        default:
          cursor = moved;
      }
    }
    if (cursor >= asOf) return cursor;
  }
  return asOf;
}

interface Occurrence {
  date: string;
  cents: number; // positive
  description: string;
}

function collapse(txs: readonly DetectTransaction[]): Occurrence[] {
  const byDay = new Map<string, Occurrence>();
  for (const t of [...txs].sort((a, b) => a.postedOn.localeCompare(b.postedOn))) {
    const prev = byDay.get(t.postedOn);
    const cents = Math.abs(t.amountCents);
    byDay.set(t.postedOn, {
      date: t.postedOn,
      cents: (prev?.cents ?? 0) + cents,
      description: prev?.description ?? t.description,
    });
  }
  return [...byDay.values()];
}

function detectGroup(
  merchantNorm: string,
  direction: "inflow" | "outflow",
  txs: readonly DetectTransaction[],
  asOf: string,
): RecurringCandidate | null {
  const occ = collapse(txs);
  if (occ.length < 2) return null;
  const dates = occ.map((o) => o.date);
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i] ?? d, d));
  const lastWeekdayPattern =
    dates.length >= 3 &&
    dates.every((d) => isLastWeekdayOfMonth(d)) &&
    new Set(dates.map(weekdayOf)).size === 1;
  const medianGap = median(gaps);
  const band = lastWeekdayPattern && medianGap >= 28 && medianGap <= 35 ? BANDS[2] : bandFor(medianGap);
  if (!band || occ.length < band.minOccurrences) return null;
  if (!(lastWeekdayPattern && band.cadence === "monthly")) {
    const inBand = gaps.filter((g) => g >= band.lo && g <= band.hi).length;
    if (inBand * 100 < gaps.length * MIN_REGULAR_SHARE_PERCENT) return null;
  }
  const lastSeen = dates[dates.length - 1] ?? asOf;
  // A subscription that stopped long ago is not "coming up".
  if (daysBetween(lastSeen, asOf) > 2 * medianGap + 7) return null;

  const cents = occ.map((o) => o.cents);
  const latest = occ[occ.length - 1];
  const schedule = scheduleFor(band, dates, lastWeekdayPattern);
  const payroll = PAYROLL.test(`${merchantNorm} ${latest?.description.toLowerCase() ?? ""}`);
  return {
    key: `${direction}:${merchantNorm}`,
    merchantNorm,
    displayName: displayName(merchantNorm),
    direction,
    kind: direction === "inflow" && (payroll || band.months <= 1) ? "paycheck" : "recurring",
    cadence: band.cadence,
    schedule,
    amountType: classifyAmounts(cents),
    amountCents: latest?.cents ?? 0,
    typicalAmountCents: median(cents),
    occurrences: occ.length,
    firstSeen: dates[0] ?? lastSeen,
    lastSeen,
    nextExpected: nextExpected(band.cadence, schedule, lastSeen, asOf),
    latestDescription: latest?.description ?? "",
  };
}

/**
 * Candidates from `transactions` as of `asOf` (the household's today). Sorted by key so the output is stable.
 * `asOf` is passed in: this package never reads a clock.
 */
export function detectRecurring(
  transactions: readonly DetectTransaction[],
  asOf: string,
): RecurringCandidate[] {
  const from = windowStart(asOf);
  const groups = new Map<string, DetectTransaction[]>();
  for (const t of transactions) {
    if (t.amountCents === 0 || t.postedOn < from || t.postedOn > asOf) continue;
    const key = `${t.amountCents > 0 ? "inflow" : "outflow"}:${t.merchantNorm}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const out: RecurringCandidate[] = [];
  for (const [key, txs] of groups) {
    const sep = key.indexOf(":");
    const direction = key.slice(0, sep) === "inflow" ? "inflow" : "outflow";
    const candidate = detectGroup(key.slice(sep + 1), direction, txs, asOf);
    if (candidate) out.push(candidate);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
