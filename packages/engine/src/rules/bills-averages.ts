// Rule 17: monthly averages on Bills & recurring. Biweekly income × 26 ÷ 12 (every n weeks: × 52 ÷ n ÷ 12),
// bills paid every n months ÷ n, yearly ÷ 12. Estimates use their current estimate.
import { divRoundHalfUp, sumCents } from "../money";
import { itemAmount } from "../occurrences";
import { affectsAccount } from "../runway";
import type { Cents, EngineInput, ItemInput, Schedule } from "../types";

/** One item's monthly average, rounded to the nearest cent (half up). */
export function monthlyAverageCents(amountCents: Cents, schedule: Schedule): Cents {
  switch (schedule.type) {
    case "every_n_weeks":
      return divRoundHalfUp(amountCents * 52, schedule.n * 12);
    case "every_n_months":
      return divRoundHalfUp(amountCents, schedule.n);
    case "yearly":
      return divRoundHalfUp(amountCents, 12);
    default:
      return amountCents;
  }
}

export interface BillsAverages {
  /** Items listed on Bills & recurring: active and paused ones (ended and pending-review items are not). */
  rows: number;
  /** Active money out paid from the account, per month. */
  monthlyBillsAverageCents: Cents;
  /** Active income, per month. */
  monthlyIncomeAverageCents: Cents;
  leftAfterBillsCents: Cents;
  /** Active money-out items whose amount is an estimate (history or statement). */
  estimatesToConfirm: number;
  byItem: { itemId: string; monthlyCents: Cents }[];
}

export function billsAverages(input: EngineInput): BillsAverages {
  const listed = input.items.filter((i) => ["active", "paused"].includes(i.status ?? "active"));
  const counted = input.items.filter((i) => (i.status ?? "active") === "active" && affectsAccount(i));
  const monthly = (i: ItemInput) => monthlyAverageCents(itemAmount(i).cents, i.schedule);
  const byItem = counted.map((i) => ({ itemId: i.id, monthlyCents: monthly(i) }));
  const bills = sumCents(counted.filter((i) => i.direction === "outflow").map(monthly));
  const income = sumCents(counted.filter((i) => i.direction === "inflow").map(monthly));
  return {
    rows: listed.length,
    monthlyBillsAverageCents: bills,
    monthlyIncomeAverageCents: income,
    leftAfterBillsCents: income - bills,
    estimatesToConfirm: counted.filter((i) => i.direction === "outflow" && itemAmount(i).isEstimate).length,
    byItem,
  };
}
