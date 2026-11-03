import { describe, expect, it } from "vitest";
import {
  CreateBalance,
  CreateItem,
  CreatePlannedExpense,
  ItemListQuery,
  MAX_MONEY_CENTS,
  PatchItem,
  PatchOccurrence,
  Schedule,
} from "./index";

const U = "00000000-0000-4000-8000-00000000000a";
const bill = {
  direction: "outflow",
  kind: "bill",
  category: "housing",
  name: "Rent",
  amountType: "fixed",
  amountCents: 215000,
  schedule: { type: "monthly_day", day: 1, dtstart: "2026-01-01" },
  ownerType: "member",
  ownerUserId: U,
};

describe("items contracts", () => {
  it("accepts the Schedule union and rejects what it cannot express", () => {
    expect(
      Schedule.safeParse({ type: "monthly_last_weekday", weekday: "friday", dtstart: "2026-01-01" }).success,
    ).toBe(true);
    expect(Schedule.safeParse({ type: "every_n_months", n: 1, dtstart: "2026-01-01" }).success).toBe(false); // monthly is monthly_day
    expect(Schedule.safeParse({ type: "monthly_day", day: 32, dtstart: "2026-01-01" }).success).toBe(false);
    expect(Schedule.safeParse({ type: "daily", dtstart: "2026-01-01" }).success).toBe(false);
    expect(Schedule.safeParse({ type: "yearly", dtstart: "2026-02-30" }).success).toBe(false);
  });

  it("requires integer cents and a consistent owner", () => {
    expect(CreateItem.safeParse(bill).success).toBe(true);
    expect(CreateItem.safeParse({ ...bill, amountCents: 10.5 }).success).toBe(false);
    expect(CreateItem.safeParse({ ...bill, ownerUserId: null }).success).toBe(false);
    expect(CreateItem.safeParse({ ...bill, ownerType: "both" }).success).toBe(false);
    expect(CreateItem.safeParse({ ...bill, amountCents: null }).success).toBe(false);
    // Q-107: estimated and statement items need an amount too (the estimate, the last statement)
    expect(CreateItem.safeParse({ ...bill, amountType: "estimated", amountCents: null }).success).toBe(false);
    expect(CreateItem.safeParse({ ...bill, amountType: "statement", amountCents: null }).success).toBe(false);
    expect(CreateItem.safeParse({ ...bill, amountType: "estimated", amountCents: 14200 }).success).toBe(true);
  });

  it("limits account numbers to the last 4 characters", () => {
    expect(CreateItem.safeParse({ ...bill, accountLast4: "4821" }).success).toBe(true);
    expect(CreateItem.safeParse({ ...bill, accountLast4: "123456789" }).success).toBe(false);
  });

  it("patches need at least one field and never change the direction", () => {
    expect(PatchItem.safeParse({}).success).toBe(false);
    expect(PatchItem.safeParse({ name: "Rent 2" }).success).toBe(true);
    expect(PatchItem.safeParse({ name: "Rent 2", direction: "inflow" }).success).toBe(false);
    expect(PatchItem.parse({ name: "Rent 2" })).toEqual({ name: "Rent 2" }); // no defaults sneak in
    expect(PatchOccurrence.safeParse({}).success).toBe(false);
    expect(PatchOccurrence.safeParse({ status: "paid", paidOn: "2026-11-01" }).success).toBe(true);
  });

  it("does not let a client name the source of an item (G1 M-2)", () => {
    expect(CreateItem.safeParse({ ...bill, source: "csv" }).success).toBe(false);
    expect(CreateItem.safeParse({ ...bill, source: "manual" }).success).toBe(false);
    expect(PatchItem.safeParse({ source: "email" }).success).toBe(false);
  });

  it("caps every money field at $1 billion (G1 L-2)", () => {
    expect(CreateItem.safeParse({ ...bill, amountCents: MAX_MONEY_CENTS }).success).toBe(true);
    expect(CreateItem.safeParse({ ...bill, amountCents: MAX_MONEY_CENTS + 1 }).success).toBe(false);
    expect(PatchOccurrence.safeParse({ actualAmountCents: MAX_MONEY_CENTS + 1 }).success).toBe(false);
    expect(
      CreatePlannedExpense.safeParse({
        name: "x",
        amountCents: MAX_MONEY_CENTS + 1,
        dueOn: "2026-11-01",
        ownerType: "both",
      }).success,
    ).toBe(false);
    expect(CreateBalance.safeParse({ amountCents: -MAX_MONEY_CENTS - 1, asOf: "2026-11-01" }).success).toBe(
      false,
    );
    expect(CreateBalance.safeParse({ amountCents: -5000, asOf: "2026-11-01" }).success).toBe(true);
  });

  it("takes a hostname for providerDomain and a uuid cursor (G1 L-2)", () => {
    for (const ok of ["northgate-insurance.example", "a.b.co"]) {
      expect(CreateItem.safeParse({ ...bill, providerDomain: ok }).success, ok).toBe(true);
    }
    for (const bad of [
      "https://evil.example/x",
      "Evil.Example",
      "a b.com",
      "evil",
      "169.254.169.254:80",
      "a..b",
    ]) {
      expect(CreateItem.safeParse({ ...bill, providerDomain: bad }).success, bad).toBe(false);
    }
    expect(ItemListQuery.safeParse({ cursor: "not-a-uuid" }).success).toBe(false);
    expect(ItemListQuery.safeParse({ cursor: U }).success).toBe(true);
  });
});
