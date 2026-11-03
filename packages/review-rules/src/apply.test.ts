// How a reviewed extraction becomes a change: pure planning from fields (+ the matched item) to item edits.
import { describe, expect, it } from "vitest";
import type { ExtractedFields, RenewalDetails } from "@mp/contracts";
import { itemFromFields, planUpdate, snapshotMatches, type PlanItem } from "./apply";

const fields = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({
  docType: "renewal_notice",
  providerName: "Northgate Home Insurance",
  category: "insurance",
  insuranceType: "renters",
  amountDueCents: 16800,
  previousAmountCents: 14900,
  dueDate: null,
  renewalDate: "2027-01-09",
  cancelByDate: "2026-12-20",
  decisionByDate: null,
  frequency: "yearly",
  autoRenews: true,
  accountLast4: "4821",
  providerDomain: null,
  ...over,
});

const renewal: RenewalDetails = {
  autoRenews: "yes",
  coverageStart: "2026-01-09",
  coverageEnd: "2027-01-09",
  cancelBy: null,
  decisionBy: "2026-12-30",
  shopAroundOn: "2026-12-10",
  previousAmountCents: null,
  priceChangedOn: null,
};

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  amountType: "fixed",
  amountCents: 14900,
  renewal,
  ...over,
});

describe("planUpdate", () => {
  it("sets a fixed item's amount and merges the renewal dates over what is there", () => {
    const plan = planUpdate("update", fields(), item());
    expect(plan.amountCents).toBe(16800);
    expect(plan.occurrenceActual).toBeNull();
    expect(plan.renewal).toEqual({
      ...renewal,
      cancelBy: "2026-12-20", // new
      decisionBy: "2026-12-30", // kept (the notice has none)
      previousAmountCents: 14900,
      autoRenews: "yes",
    });
  });

  it("an estimated item records the actual on the matching occurrence instead of fixing an amount", () => {
    const plan = planUpdate(
      "update",
      fields({ docType: "bill", dueDate: "2026-11-15", renewalDate: null }),
      item({ amountType: "estimated", amountCents: null }),
    );
    expect(plan.amountCents).toBeNull();
    expect(plan.occurrenceActual).toEqual({ dueDate: "2026-11-15", amountCents: 16800 });
  });

  it("a statement item's last statement amount is updated", () => {
    expect(planUpdate("update", fields(), item({ amountType: "statement" })).amountCents).toBe(16800);
  });

  it("a decision applies the dates and never the amount", () => {
    const plan = planUpdate(
      "decision",
      fields({ docType: "enrollment_deadline", decisionByDate: "2026-12-01" }),
      item(),
    );
    expect(plan.amountCents).toBeNull();
    expect(plan.renewal?.decisionBy).toBe("2026-12-01");
  });

  it("a duplicate changes nothing", () => {
    expect(planUpdate("duplicate", fields(), item())).toEqual({
      amountCents: null,
      occurrenceActual: null,
      renewal: null,
    });
  });

  it("no renewal fields means no renewal write", () => {
    const plan = planUpdate(
      "update",
      fields({
        renewalDate: null,
        cancelByDate: null,
        previousAmountCents: null,
        autoRenews: null,
        frequency: null,
      }),
      item(),
    );
    expect(plan.renewal).toBeNull();
  });

  it("a renewal is created from defaults when the item had none", () => {
    const plan = planUpdate("update", fields(), item({ renewal: null }));
    expect(plan.renewal).toMatchObject({
      autoRenews: "yes",
      coverageEnd: "2027-01-09",
      cancelBy: "2026-12-20",
      coverageStart: null,
    });
  });

  it("autoRenews false becomes no", () => {
    expect(planUpdate("update", fields({ autoRenews: false }), item()).renewal?.autoRenews).toBe("no");
  });

  it("skips an amount that is already there", () => {
    expect(planUpdate("update", fields({ amountDueCents: 14900 }), item()).amountCents).toBeNull();
  });
});

describe("itemFromFields (a new item)", () => {
  const owner = "00000000-0000-4000-8000-0000000000a1";

  it("builds a yearly insurance item with its renewal", () => {
    const r = itemFromFields(fields(), { ownerUserId: owner });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item).toMatchObject({
      direction: "outflow",
      kind: "insurance",
      category: "insurance",
      name: "Northgate Home Insurance",
      providerName: "Northgate Home Insurance",
      providerDomain: null, // never copied from the sender (M3)
      amountType: "fixed",
      amountCents: 16800,
      schedule: { type: "yearly", dtstart: "2027-01-09" },
      ownerType: "member",
      ownerUserId: owner,
      accountLast4: "4821",
    });
    expect(r.renewal).toMatchObject({
      coverageEnd: "2027-01-09",
      cancelBy: "2026-12-20",
      previousAmountCents: 14900,
    });
  });

  it("maps frequencies to schedules", () => {
    const sched = (frequency: ExtractedFields["frequency"], dueDate = "2026-11-15") => {
      const r = itemFromFields(fields({ docType: "bill", frequency, dueDate, renewalDate: null }), {
        ownerUserId: owner,
      });
      return r.ok ? r.item.schedule : r;
    };
    expect(sched("monthly")).toEqual({ type: "monthly_day", day: 15, dtstart: "2026-11-15" });
    expect(sched("every_2_months")).toEqual({ type: "every_n_months", n: 2, dtstart: "2026-11-15" });
    expect(sched("quarterly")).toEqual({ type: "every_n_months", n: 3, dtstart: "2026-11-15" });
    expect(sched("every_6_months")).toEqual({ type: "every_n_months", n: 6, dtstart: "2026-11-15" });
    expect(sched("yearly")).toEqual({ type: "yearly", dtstart: "2026-11-15" });
    expect(sched("one_time")).toEqual({ type: "yearly", dtstart: "2026-11-15", until: "2026-11-15" });
  });

  it("asks for the missing piece instead of guessing", () => {
    const owner2 = { ownerUserId: owner };
    expect(itemFromFields(fields({ providerName: null }), owner2)).toMatchObject({
      ok: false,
      field: "providerName",
    });
    expect(itemFromFields(fields({ dueDate: null, renewalDate: null }), owner2)).toMatchObject({
      ok: false,
      field: "dueDate",
    });
    expect(itemFromFields(fields({ frequency: null }), owner2)).toMatchObject({
      ok: false,
      field: "frequency",
    });
  });

  it("income is an inflow; a missing amount makes an estimate; a bad domain or last 4 is dropped", () => {
    const r = itemFromFields(
      fields({
        docType: "statement",
        category: "income",
        amountDueCents: null,
        frequency: "monthly",
        dueDate: "2026-11-30",
        renewalDate: null,
        accountLast4: "1",
      }),
      { ownerUserId: owner },
    );
    expect(r.ok && r.item).toMatchObject({
      direction: "inflow",
      kind: "income",
      amountType: "estimated",
      providerDomain: null,
      accountLast4: null,
    });
    expect(r.ok && r.item.amountCents).toBeFalsy();
  });

  it("a bill from a statement is a statement item", () => {
    const r = itemFromFields(
      fields({
        docType: "bill",
        category: "utilities",
        frequency: "monthly",
        dueDate: "2026-11-15",
        renewalDate: null,
        cancelByDate: null,
        previousAmountCents: null,
        autoRenews: null,
      }),
      { ownerUserId: owner },
    );
    expect(r.ok && r.item.amountType).toBe("statement");
    expect(r.ok && r.renewal).toBeNull();
  });
});

describe("snapshotMatches", () => {
  it("compares only the keys the change wrote", () => {
    expect(snapshotMatches({ amountCents: 16800 }, { amountCents: 16800, renewal: null })).toBe(true);
    expect(snapshotMatches({ amountCents: 16800 }, { amountCents: 17000 })).toBe(false);
    expect(snapshotMatches({ renewal: { a: 1, b: 2 } }, { renewal: { b: 2, a: 1 } })).toBe(true);
    expect(snapshotMatches({ renewal: { a: 1 } }, { renewal: { a: 2 } })).toBe(false);
  });
});
