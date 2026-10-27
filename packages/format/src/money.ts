// Money formatting per DESIGN_SPEC §7 (rounding rules there and in §6 rule 4).
// Input is always integer cents (hard rule 1). All arithmetic stays in integers.

/** U+2212 MINUS SIGN. Outflows use this, never a hyphen (DESIGN_SPEC §7). */
export const MINUS = "−";

/**
 * - `detail`: tables, lists, detail panels and bill totals. `$2,150.00`.
 * - `headline`: hero and KPI tiles, whole dollars. `$1,007`. See {@link HeadlineRounding}.
 * - `signed`: mixed lists and charts. `+$2,900.00` for income, `−$389.00` for outflows.
 * - `chip`: calendar chips and per-year changes. Signed; whole dollars rounded to the nearest
 *   dollar at $100 or more (`+$3,150`, `−$1,263`); smaller amounts keep cents (`−$22.99`),
 *   dropping `.00` only when the amount is whole (`+$55`).
 * - `estimate`: variable bills before the actual arrives. `~$142.00`; negative `~−$142.00`.
 *
 * `detail`, `headline` and `estimate` show a negative value with `−`; they never add `+`.
 */
export type MoneyMode = "detail" | "headline" | "signed" | "chip" | "estimate";

/**
 * Headline rounding (DESIGN_SPEC §7). Money you can spend (safe to spend, per day) rounds
 * down: `floor`, the default. Averages and summaries round to the `nearest` dollar, half away
 * from zero. Shortfalls round up: use {@link shortfall}.
 */
export type HeadlineRounding = "floor" | "nearest";

export type MoneyOptions =
  { mode: Exclude<MoneyMode, "headline"> } | { mode: "headline"; rounding?: HeadlineRounding };

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError("Money must be a safe integer number of cents.");
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats a non-negative integer number of cents as `$1,234.56`. */
function dollarsAndCents(absCents: number): string {
  const dollars = Math.trunc(absCents / 100);
  const rest = absCents - dollars * 100;
  return `$${groupThousands(String(dollars))}.${String(rest).padStart(2, "0")}`;
}

/** Formats a non-negative integer number of whole dollars as `$1,234`. */
function wholeDollars(absDollars: number): string {
  return `$${groupThousands(String(absDollars))}`;
}

/** Floor division of integer cents to whole dollars (toward −∞), exact for safe integers. */
function floorDollars(cents: number): number {
  const rem = ((cents % 100) + 100) % 100;
  return (cents - rem) / 100;
}

/** Ceiling division of non-negative integer cents to whole dollars, exact for safe integers. */
function ceilDollars(absCents: number): number {
  const rem = absCents % 100;
  return (absCents - rem) / 100 + (rem === 0 ? 0 : 1);
}

/** Nearest whole dollar of non-negative integer cents, half up, exact for safe integers. */
function nearestDollars(absCents: number): number {
  const rem = absCents % 100;
  return (absCents - rem) / 100 + (rem >= 50 ? 1 : 0);
}

const signOf = (cents: number): string => (cents < 0 ? MINUS : cents > 0 ? "+" : "");

export function money(cents: number, options: MoneyOptions = { mode: "detail" }): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  switch (options.mode) {
    case "detail":
      return `${negative ? MINUS : ""}${dollarsAndCents(abs)}`;
    case "estimate":
      return `~${negative ? MINUS : ""}${dollarsAndCents(abs)}`;
    case "signed":
      return `${signOf(cents)}${dollarsAndCents(abs)}`;
    case "chip": {
      if (abs >= 10000) return `${signOf(cents)}${wholeDollars(nearestDollars(abs))}`;
      return `${signOf(cents)}${abs % 100 === 0 ? wholeDollars(abs / 100) : dollarsAndCents(abs)}`;
    }
    case "headline": {
      if (options.rounding === "nearest") {
        const dollars = nearestDollars(abs);
        return `${negative && dollars > 0 ? MINUS : ""}${wholeDollars(dollars)}`;
      }
      const dollars = floorDollars(cents);
      return `${dollars < 0 ? MINUS : ""}${wholeDollars(Math.abs(dollars))}`;
    }
  }
}

/**
 * The shortfall hero: the amount rounded up to whole dollars (§6 rule 4).
 * Pass the negative safe-to-spend value or the positive gap; the sign is ignored.
 * `shortfall(-79299)` → `$793 short`.
 */
export function shortfall(cents: number): string {
  assertCents(cents);
  if (cents === 0) {
    throw new RangeError("A shortfall must be non-zero.");
  }
  return `${wholeDollars(ceilDollars(Math.abs(cents)))} short`;
}

export interface EstimateRangeOptions {
  /** Prefix the chip label: `Estimate ±$30`. */
  label?: boolean;
}

/**
 * The estimate range chip (§7). The engine rounds ranges up to the nearest $10 (§6 rule 6),
 * so whole dollars are shown; a range with cents keeps them rather than hiding precision.
 * `estimateRange(3000)` → `±$30`.
 */
export function estimateRange(cents: number, options: EstimateRangeOptions = {}): string {
  assertCents(cents);
  if (cents < 0) {
    throw new RangeError("An estimate range must not be negative.");
  }
  const amount = cents % 100 === 0 ? wholeDollars(cents / 100) : dollarsAndCents(cents);
  return `${options.label ? "Estimate " : ""}±${amount}`;
}
