import { riveraInput } from "../testing";
import type { EngineInput, Flag, ItemInput, RenewalInput } from "../types";
import { flags, isInfrequent, ruleFlags, sortFlags } from "./flags";
import { isPriceUp, priceUpShowing } from "./price";
import { parseDate } from "../dates";

const asOf = parseDate("2026-10-27");

function renewal(r: Partial<RenewalInput>): RenewalInput {
  return {
    id: "r-x",
    name: "X",
    category: "insurance",
    owner: "m-sam",
    amountCents: 10000,
    every: { unit: "month", n: 12 },
    renewsOn: "2027-01-01",
    autoRenews: "yes",
    sources: ["email"],
    ...r,
  };
}

function withRenewals(...renewals: RenewalInput[]): EngineInput {
  return { ...riveraInput(), renewals };
}

function only(input: EngineInput, code: Flag["code"]): Flag[] {
  return ruleFlags(input).filter((f) => f.code === code);
}

describe("flags on the Rivera household (rule 8, DESIGN_SPEC fixture items)", () => {
  const all = flags(riveraInput());

  it("fire for exactly the fixture items", () => {
    expect(all).toEqual([
      { code: "not_usual_month", subjectId: "b-carins", date: "2026-11-04" },
      { code: "price_up", subjectId: "b-stream", date: "2026-09-28" },
      { code: "price_up", subjectId: "r-renters", date: null },
      { code: "possible_duplicate", subjectId: "b-music2", date: null, relatedIds: ["b-music2", "b-musicf"] },
      // Rule 8: "an email gives a deadline (enrollment, cancel-by)". See QUESTIONS.md Q-015.
      { code: "decide_by", subjectId: "r-health", date: "2026-11-13", deadlineKind: "decision" },
      { code: "decide_by", subjectId: "r-av", date: "2026-11-30", deadlineKind: "cancel" },
      { code: "not_automatic", subjectId: "r-reg", date: "2027-01-31" },
      { code: "estimate", subjectId: "b-power", date: "2026-11-03" },
      { code: "estimate", subjectId: "b-card", date: "2026-11-15" },
    ]);
  });

  it("counts per DESIGN_SPEC: not usual month, price up ×2, possible duplicate, estimate ×2, not automatic", () => {
    const count = (code: Flag["code"]) => all.filter((f) => f.code === code).length;
    expect(count("not_usual_month")).toBe(1);
    expect(count("price_up")).toBe(2);
    expect(count("possible_duplicate")).toBe(1);
    expect(count("estimate")).toBe(2);
    expect(count("not_automatic")).toBe(1);
    expect(count("stale_balance")).toBe(0);
    expect(count("overdue")).toBe(0);
  });

  it("include stale_balance from the core plan", () => {
    const input = { ...riveraInput(), startingBalance: { cents: 340000, asOf: "2026-10-19" } };
    expect(flags(input)[0]).toEqual({ code: "stale_balance", subjectId: null, date: "2026-10-19" });
  });
});

describe("not in your usual month", () => {
  it("is for every-n-months and yearly schedules only", () => {
    expect(isInfrequent({ type: "every_n_months", n: 3, dtstart: "2026-01-01" })).toBe(true);
    expect(isInfrequent({ type: "yearly", dtstart: "2026-01-01" })).toBe(true);
    expect(isInfrequent({ type: "monthly_day", day: 1, dtstart: "2026-01-01" })).toBe(false);
    expect(isInfrequent({ type: "every_n_weeks", n: 2, dtstart: "2026-01-02" })).toBe(false);
    // Every 9 weeks is rarer than every 2 months; every 8 weeks is not.
    expect(isInfrequent({ type: "every_n_weeks", n: 8, dtstart: "2026-01-02" })).toBe(false);
    expect(isInfrequent({ type: "every_n_weeks", n: 9, dtstart: "2026-01-02" })).toBe(true);
  });

  it("ignores a skipped occurrence and payroll items", () => {
    const skipped = riveraInput({
      occurrences: [{ itemId: "b-carins", scheduledOn: "2026-11-04", status: "skipped" }],
    });
    expect(only(skipped, "not_usual_month")).toEqual([]);
    const payroll = riveraInput();
    (payroll.items.find((i) => i.id === "b-carins") as ItemInput).paidFrom = "payroll";
    expect(only(payroll, "not_usual_month")).toEqual([]);
  });

  it("ignores a paid occurrence whose due date is outside the window", () => {
    // Paid early, on Oct 28: its due date (Nov 4) is still in the window, so it still flags.
    const paid = riveraInput({
      occurrences: [{ itemId: "b-carins", scheduledOn: "2026-11-04", status: "paid", paidOn: "2026-10-28" }],
    });
    expect(only(paid, "not_usual_month")).toHaveLength(1);
    // Moved past payday: due Nov 9, outside the window, though resolved in range by nothing else.
    const moved = riveraInput({
      occurrences: [{ itemId: "b-carins", scheduledOn: "2026-11-04", dueOn: "2026-11-09" }],
    });
    expect(only(moved, "not_usual_month")).toEqual([]);
  });

  it("uses an explicit window", () => {
    expect(
      ruleFlags(riveraInput(), { from: "2026-11-07", to: "2026-11-20", daysToPayday: 13 }),
    ).toContainEqual({
      code: "not_usual_month",
      subjectId: "b-water",
      date: "2026-11-18",
    });
  });
});

describe("price up", () => {
  it("needs at least $1 and at least 2%", () => {
    expect(isPriceUp(1999, 2299)).toBe(true);
    expect(isPriceUp(1999, 2098)).toBe(false); // $0.99
    expect(isPriceUp(10000, 10199)).toBe(false); // $1.99 but 1.99%
    expect(isPriceUp(10000, 10200)).toBe(true); // $2 and 2%
    expect(isPriceUp(2299, 1999)).toBe(false);
  });

  it("shows for 60 days, or until reviewed", () => {
    const p = { amountCents: 2299, previousAmountCents: 1999 };
    expect(priceUpShowing({ ...p, priceChangedOn: "2026-08-29" }, asOf)).toBe(true); // 59 days
    expect(priceUpShowing({ ...p, priceChangedOn: "2026-08-28" }, asOf)).toBe(false); // 60 days
    expect(priceUpShowing({ ...p, priceChangeReviewed: true }, asOf)).toBe(false);
    expect(priceUpShowing({ ...p, previousAmountCents: null }, asOf)).toBe(false);
    expect(priceUpShowing({ amountCents: 2000, previousAmountCents: 1999 }, asOf)).toBe(false);
  });

  it("also covers items with no renewal row", () => {
    const input = riveraInput();
    const internet = input.items.find((i) => i.id === "b-internet") as ItemInput;
    internet.previousAmountCents = 6000;
    const rent = input.items.find((i) => i.id === "b-rent") as ItemInput;
    rent.previousAmountCents = 200000;
    rent.status = "paused";
    expect(only(input, "price_up").map((f) => f.subjectId)).toEqual(["b-stream", "b-internet", "r-renters"]);
  });

  it("uses the item id for a renewal linked to an item", () => {
    const input = withRenewals(renewal({ id: "r-1", itemId: "b-carins", previousAmountCents: 9000 }));
    expect(only(input, "price_up").filter((f) => f.subjectId !== "b-stream")).toEqual([
      { code: "price_up", subjectId: "b-carins", date: null },
    ]);
  });
});

describe("possible duplicate", () => {
  it("picks the cheapest when none is marked unused, then by id", () => {
    const input = withRenewals(
      renewal({ id: "r-b", category: "subscription", subcategory: "video", amountCents: 1500 }),
      renewal({ id: "r-a", category: "subscription", subcategory: "video", amountCents: 1500 }),
      renewal({ id: "r-c", category: "subscription", subcategory: "video", amountCents: 900 }),
      renewal({ id: "r-d", category: "subscription", subcategory: "news" }),
      renewal({ id: "r-e", category: "membership", subcategory: "news" }),
      renewal({ id: "r-f", category: "subscription", subcategory: "" }),
    );
    const dupes = only(input, "possible_duplicate");
    expect(dupes).toContainEqual({
      code: "possible_duplicate",
      subjectId: "r-c",
      date: null,
      relatedIds: ["r-a", "r-b", "r-c"],
    });
    expect(dupes.map((f) => f.subjectId)).not.toContain("r-d");
  });

  it("orders ties by id", () => {
    const input = withRenewals(
      renewal({ id: "r-b", category: "subscription", subcategory: "video", amountCents: 1500 }),
      renewal({ id: "r-a", category: "subscription", subcategory: "video", amountCents: 1500 }),
    );
    expect(only(input, "possible_duplicate").find((f) => f.relatedIds?.includes("r-a"))?.subjectId).toBe(
      "r-a",
    );
  });
});

describe("decide by and not automatic", () => {
  it("uses the earliest upcoming deadline and ignores past ones", () => {
    const input = withRenewals(
      renewal({ id: "r-1", decisionBy: "2026-12-01", cancelBy: "2026-11-20" }),
      renewal({ id: "r-2", decisionBy: "2026-10-01" }),
      renewal({ id: "r-3", autoRenews: "no", renewsOn: "2025-12-15" }),
      renewal({ id: "r-4", autoRenews: "rolls_over" }),
    );
    expect(only(input, "decide_by")).toEqual([
      { code: "decide_by", subjectId: "r-1", date: "2026-11-20", deadlineKind: "cancel" },
    ]);
    // A renewal date in the past rolls forward a year.
    expect(only(input, "not_automatic")).toEqual([
      { code: "not_automatic", subjectId: "r-3", date: "2026-12-15" },
    ]);
  });
});

describe("estimate", () => {
  it("moves to the next occurrence once the actual arrives, and skips paused items", () => {
    const input = riveraInput({
      occurrences: [{ itemId: "b-power", scheduledOn: "2026-11-03", actualAmountCents: 15137 }],
    });
    (input.items.find((i) => i.id === "b-card") as ItemInput).status = "paused";
    expect(only(input, "estimate")).toEqual([{ code: "estimate", subjectId: "b-power", date: "2026-12-03" }]);
  });

  it("ignores occurrences already paid and rows due before today", () => {
    const input = riveraInput({
      occurrences: [{ itemId: "b-power", scheduledOn: "2026-11-03", status: "paid", paidOn: "2026-10-27" }],
    });
    expect(only(input, "estimate").find((f) => f.subjectId === "b-power")?.date).toBe("2026-12-03");
    // An occurrence due before asOf but paid inside the range is resolved, yet not flagged.
    const early = riveraInput({
      occurrences: [
        { itemId: "b-power", scheduledOn: "2026-10-03", dueOn: "2026-10-03", paidOn: "2026-10-28" },
      ],
    });
    expect(only(early, "estimate").find((f) => f.subjectId === "b-power")?.date).toBe("2026-11-03");
  });
});

describe("overdue (QUESTIONS.md Q-006)", () => {
  it("flags a materialized occurrence still scheduled before the balance date", () => {
    const input = riveraInput({
      occurrences: [
        { itemId: "b-car", scheduledOn: "2026-09-29" },
        { itemId: "b-phone", scheduledOn: "2026-09-30", dueOn: "2026-10-01", status: "scheduled" },
        { itemId: "b-rent", scheduledOn: "2026-10-01", status: "paid", paidOn: "2026-10-01" },
        { itemId: "b-internet", scheduledOn: "2026-11-05" },
      ],
    });
    (input.items.find((i) => i.id === "b-car") as ItemInput).weekendRule = "next_business_day";
    expect(only(input, "overdue")).toEqual([
      { code: "overdue", subjectId: "b-car", date: "2026-09-29" },
      { code: "overdue", subjectId: "b-phone", date: "2026-10-01" },
    ]);
  });

  it("ignores rows of paused items", () => {
    const input = riveraInput({ occurrences: [{ itemId: "b-car", scheduledOn: "2026-09-29" }] });
    (input.items.find((i) => i.id === "b-car") as ItemInput).status = "paused";
    expect(only(input, "overdue")).toEqual([]);
  });
});

describe("sortFlags", () => {
  it("orders by code, then date (undated last), then subject", () => {
    const sorted = sortFlags([
      { code: "price_up", subjectId: "b", date: null },
      { code: "price_up", subjectId: "a", date: null },
      { code: "price_up", subjectId: "c", date: "2026-01-01" },
      { code: "stale_balance", subjectId: null, date: "2026-01-01" },
      { code: "stale_balance", subjectId: "x", date: "2026-01-01" },
    ]);
    expect(sorted.map((f) => f.subjectId)).toEqual([null, "x", "c", "a", "b"]);
  });
});
