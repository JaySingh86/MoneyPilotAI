// Rule 8 "Price up": the new amount exceeds the previous term by at least $1 and at least 2%. It shows
// until reviewed or for 60 days after the change.
import { daysBetween, parseDate } from "../dates";
import type { PlainDate } from "../dates";
import type { Cents, IsoDate } from "../types";

export const PRICE_UP_MIN_CENTS = 100;
export const PRICE_UP_MIN_PERCENT = 2;
export const PRICE_UP_SHOW_DAYS = 60;

export function isPriceUp(previousCents: Cents, currentCents: Cents): boolean {
  const increase = currentCents - previousCents;
  return increase >= PRICE_UP_MIN_CENTS && increase * 100 >= previousCents * PRICE_UP_MIN_PERCENT;
}

export interface PricedThing {
  amountCents: Cents;
  previousAmountCents?: Cents | null;
  priceChangedOn?: IsoDate | null;
  priceChangeReviewed?: boolean;
}

/**
 * True while the price-up flag shows: a qualifying increase, not reviewed, and fewer than 60 days since the
 * change (a change with no date shows until reviewed).
 */
export function priceUpShowing(p: PricedThing, asOf: PlainDate): boolean {
  if (p.previousAmountCents == null || p.priceChangeReviewed === true) return false;
  if (!isPriceUp(p.previousAmountCents, p.amountCents)) return false;
  if (p.priceChangedOn == null) return true;
  return daysBetween(parseDate(p.priceChangedOn, "priceChangedOn"), asOf) < PRICE_UP_SHOW_DAYS;
}
