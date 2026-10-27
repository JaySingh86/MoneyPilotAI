// Rules 3–5: lowest point, safe to spend, per day.
import { ceilToWholeDollars, floorToMultiple, floorToWholeDollars } from "./money";
import type { Cents, IsoDate, RunwayDay } from "./types";

/**
 * The days the lowest point is taken over: the window without its final payday (rule 3). The planning
 * window always has at least 2 days (the payday is strictly after today, Q-007); a 1-day runway passed in
 * directly is used as is.
 */
export function daysBeforePayday(days: readonly RunwayDay[]): readonly RunwayDay[] {
  return days.length > 1 ? days.slice(0, -1) : days;
}

/** Rule 3: the minimum end-of-day balance, excluding the final payday. The earliest day wins a tie. */
export function lowestPoint(days: readonly RunwayDay[]): { date: IsoDate; balanceCents: Cents } {
  let lowest: RunwayDay | undefined;
  for (const day of daysBeforePayday(days)) {
    if (lowest === undefined || day.endBalanceCents < lowest.endBalanceCents) lowest = day;
  }
  if (lowest === undefined) throw new RangeError("the runway has no days");
  return { date: lowest.date, balanceCents: lowest.endBalanceCents };
}

export interface SafeToSpend {
  state: "on_track" | "shortfall";
  /** lowest − cushion, may be negative. */
  safeToSpendCents: Cents;
  /** Floored to whole dollars when on track, else null. */
  safeToSpendDisplayCents: Cents | null;
  /** The shortfall rounded up to whole dollars (positive), else null: −$792.99 → 79300. */
  shortfallDisplayCents: Cents | null;
}

/** Rule 4. */
export function safeToSpend(lowestCents: Cents, cushionCents: Cents): SafeToSpend {
  const safe = lowestCents - cushionCents;
  if (safe < 0) {
    return {
      state: "shortfall",
      safeToSpendCents: safe,
      safeToSpendDisplayCents: null,
      shortfallDisplayCents: ceilToWholeDollars(-safe),
    };
  }
  return {
    state: "on_track",
    safeToSpendCents: safe,
    safeToSpendDisplayCents: floorToWholeDollars(safe),
    shortfallDisplayCents: null,
  };
}

/** Rule 5 step: per-day amounts round down to the nearest $5. */
export const PER_DAY_STEP_CENTS = 500;

/** Rule 5: safe to spend ÷ days to payday, floored to $5. Null in a shortfall (or for 0 days). */
export function perDay(safeToSpendCents: Cents, daysToPayday: number): Cents | null {
  if (safeToSpendCents < 0 || daysToPayday <= 0) return null;
  return floorToMultiple(Math.floor(safeToSpendCents / daysToPayday), PER_DAY_STEP_CENTS);
}

/** The first day that ends below the cushion, excluding the final payday. */
export function belowCushionFrom(days: readonly RunwayDay[], cushionCents: Cents): IsoDate | null {
  return daysBeforePayday(days).find((d) => d.endBalanceCents < cushionCents)?.date ?? null;
}

/** Days that end below $0, excluding the final payday. */
export function belowZeroDates(days: readonly RunwayDay[]): IsoDate[] {
  return daysBeforePayday(days)
    .filter((d) => d.endBalanceCents < 0)
    .map((d) => d.date);
}
