// Rule 6: estimates. A variable bill uses the mean of its last 3 amounts, with a range of
// ±(max − min) ÷ 2 rounded up to the nearest $10. A credit card uses the last statement balance.
import { ceilToMultiple } from "../money";
import { itemAmount } from "../occurrences";
import type { Cents, ItemInput } from "../types";

/** Rule 6: the range rounds up to a multiple of $10. */
export const ESTIMATE_RANGE_STEP_CENTS = 1000;

/** How many of the latest amounts the estimate averages. */
export const ESTIMATE_HISTORY_SIZE = 3;

export interface Estimate {
  /** The planned amount: fixed, the mean of the last 3 amounts, or the last statement. */
  amountCents: Cents;
  isEstimate: boolean;
  basis: "fixed" | "history" | "statement";
  /** ± range for history estimates; null otherwise. */
  rangeCents: Cents | null;
  /** The amounts the estimate uses, oldest → newest (history estimates only). */
  historyCents: Cents[];
  minCents: Cents | null;
  maxCents: Cents | null;
}

/**
 * ±(max − min) ÷ 2, rounded up to the nearest $10. Rounding (max − min) up to $20 and halving is the same
 * thing and stays in integers.
 */
export function estimateRange(historyCents: readonly Cents[]): Cents {
  const spread = Math.max(...historyCents) - Math.min(...historyCents);
  return ceilToMultiple(spread, 2 * ESTIMATE_RANGE_STEP_CENTS) / 2;
}

export function estimate(item: ItemInput): Estimate {
  const planned = itemAmount(item);
  const a = item.amount;
  if (a.type === "estimated") {
    const history = a.historyCents.slice(-ESTIMATE_HISTORY_SIZE);
    return {
      amountCents: planned.cents,
      isEstimate: true,
      basis: "history",
      rangeCents: estimateRange(history),
      historyCents: history,
      minCents: Math.min(...history),
      maxCents: Math.max(...history),
    };
  }
  return {
    amountCents: planned.cents,
    isEstimate: planned.isEstimate,
    basis: a.type === "statement" ? "statement" : "fixed",
    rangeCents: null,
    historyCents: [],
    minCents: null,
    maxCents: null,
  };
}
