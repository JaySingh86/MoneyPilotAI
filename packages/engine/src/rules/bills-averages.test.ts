import { riveraInput } from "../testing";
import type { ItemInput } from "../types";
import { billsAverages, monthlyAverageCents } from "./bills-averages";

describe("monthlyAverageCents (rule 17)", () => {
  it("biweekly × 26 ÷ 12, every n months ÷ n, yearly ÷ 12, monthly as is", () => {
    expect(monthlyAverageCents(315000, { type: "every_n_weeks", n: 2, dtstart: "2026-11-06" })).toBe(682500);
    expect(monthlyAverageCents(68400, { type: "every_n_months", n: 6, dtstart: "2026-11-04" })).toBe(11400);
    expect(monthlyAverageCents(9600, { type: "every_n_months", n: 3, dtstart: "2026-11-18" })).toBe(3200);
    expect(monthlyAverageCents(18600, { type: "yearly", dtstart: "2027-01-31" })).toBe(1550);
    expect(monthlyAverageCents(9500, { type: "monthly_last_day", dtstart: "2026-01-01" })).toBe(9500);
    expect(
      monthlyAverageCents(290000, { type: "monthly_last_weekday", weekday: "friday", dtstart: "2026-01-01" }),
    ).toBe(290000);
  });

  it("rounds to the nearest cent", () => {
    expect(monthlyAverageCents(1000, { type: "yearly", dtstart: "2027-01-01" })).toBe(83); // 83.33
    expect(monthlyAverageCents(1001, { type: "every_n_months", n: 2, dtstart: "2027-01-01" })).toBe(501); // 500.5
  });
});

describe("billsAverages", () => {
  it("lists paused items but averages active, account-paid ones only", () => {
    const input = riveraInput();
    (input.items.find((i) => i.id === "b-rent") as ItemInput).status = "paused";
    (input.items.find((i) => i.id === "b-car") as ItemInput).paidFrom = "payroll";
    (input.items.find((i) => i.id === "b-phone") as ItemInput).status = "ended";
    (input.items.find((i) => i.id === "b-news") as ItemInput).status = "pending_review";
    const b = billsAverages(input);
    expect(b.rows).toBe(16);
    expect(b.monthlyBillsAverageCents).toBe(495694 - 215000 - 38900 - 9500 - 800);
    expect(b.estimatesToConfirm).toBe(2);
    expect(b.byItem.find((x) => x.itemId === "inc-sam")).toEqual({ itemId: "inc-sam", monthlyCents: 682500 });
  });

  it("skips items that exist only as renewals (onBillsPage false): rows and averages are unchanged (rule 17, Q-020)", () => {
    const input = riveraInput();
    const base = billsAverages(input);
    expect(base.rows).toBe(18);
    expect(base.monthlyBillsAverageCents).toBe(495694);
    const renewalOnly: ItemInput = {
      id: "b-renters",
      name: "Renters insurance",
      direction: "outflow",
      kind: "insurance",
      owner: "m-sam",
      amount: { type: "fixed", cents: 16800 },
      schedule: { type: "yearly", dtstart: "2027-01-09" },
      onBillsPage: false,
    };
    input.items.push(renewalOnly);
    const withRenewalOnly = billsAverages(input);
    expect(withRenewalOnly.rows).toBe(18);
    expect(withRenewalOnly.monthlyBillsAverageCents).toBe(495694);
    expect(withRenewalOnly.byItem.some((x) => x.itemId === "b-renters")).toBe(false);
    // True and absent both count, so the flag only ever removes items.
    renewalOnly.onBillsPage = true;
    const listed = billsAverages(input);
    expect(listed.rows).toBe(19);
    expect(listed.monthlyBillsAverageCents).toBe(495694 + 1400);
  });
});
