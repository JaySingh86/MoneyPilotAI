// Integer-cents arithmetic (ADR-007). No floats for money: every helper works on safe integers.
import { EngineError } from "./errors";
import type { Cents } from "./types";

/** Returns `value` if it is a safe integer number of cents, otherwise throws. */
export function assertCents(value: number, field: string): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new EngineError("invalid_cents", `${field} must be a safe integer number of cents`);
  }
  return value;
}

/** Floors to a multiple of `step` (> 0), toward −∞. */
export function floorToMultiple(cents: Cents, step: number): Cents {
  if (!Number.isSafeInteger(step) || step <= 0) {
    throw new EngineError("invalid_input", "step must be a positive integer");
  }
  const rem = ((cents % step) + step) % step;
  return cents - rem;
}

/** Ceils to a multiple of `step` (> 0), toward +∞. */
export function ceilToMultiple(cents: Cents, step: number): Cents {
  const floored = floorToMultiple(cents, step);
  return floored === cents ? cents : floored + step;
}

export function floorToWholeDollars(cents: Cents): Cents {
  return floorToMultiple(cents, 100);
}

export function ceilToWholeDollars(cents: Cents): Cents {
  return ceilToMultiple(cents, 100);
}

/** Integer division rounded half up (toward +∞ on a tie). */
export function divRoundHalfUp(numerator: number, divisor: number): number {
  if (!Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new EngineError("invalid_input", "divisor must be a positive integer");
  }
  const q = Math.floor(numerator / divisor);
  const rem = numerator - q * divisor;
  return 2 * rem >= divisor ? q + 1 : q;
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return assertCents(total, "sum");
}
