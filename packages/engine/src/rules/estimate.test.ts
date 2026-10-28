import type { ItemInput } from "../types";
import { estimate, estimateRange } from "./estimate";

function item(amount: ItemInput["amount"]): ItemInput {
  return {
    id: "x",
    name: "X",
    direction: "outflow",
    kind: "bill",
    owner: "m-a",
    amount,
    schedule: { type: "monthly_day", day: 3, dtstart: "2026-01-01" },
  };
}

describe("estimate (rule 6)", () => {
  it("uses the mean of the last 3 amounts and ±(max − min)/2 up to $10", () => {
    const e = estimate(item({ type: "estimated", historyCents: [99999, 11800, 17100, 13700] }));
    expect(e).toEqual({
      amountCents: 14200,
      isEstimate: true,
      basis: "history",
      rangeCents: 3000,
      historyCents: [11800, 17100, 13700],
      minCents: 11800,
      maxCents: 17100,
    });
  });

  it("rounds the range up to the next $10, and keeps exact multiples", () => {
    expect(estimateRange([10000, 10001])).toBe(1000); // ±$0.005 → $10
    expect(estimateRange([10000, 12000])).toBe(1000); // ±$10 exactly
    expect(estimateRange([10000, 12001])).toBe(2000); // ±$10.005 → $20
    expect(estimateRange([5000])).toBe(0);
  });

  it("works with fewer than 3 amounts", () => {
    const e = estimate(item({ type: "estimated", historyCents: [1000, 2001] }));
    expect(e.amountCents).toBe(1501); // 1500.5 rounds half up
    expect(e.historyCents).toEqual([1000, 2001]);
  });

  it("uses the last statement for a credit card, with no range", () => {
    const e = estimate(item({ type: "statement", lastStatementCents: 64000 }));
    expect(e).toMatchObject({ amountCents: 64000, isEstimate: true, basis: "statement", rangeCents: null });
  });

  it("is not an estimate for a fixed amount", () => {
    const e = estimate(item({ type: "fixed", cents: 38900 }));
    expect(e).toMatchObject({ amountCents: 38900, isEstimate: false, basis: "fixed", minCents: null });
  });
});
