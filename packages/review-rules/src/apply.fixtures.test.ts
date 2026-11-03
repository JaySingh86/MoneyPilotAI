// Fixtures for the category mappings (Q-123), the confirmed provider domain (M3) and the strict auto-apply plan (M2).
import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "@mp/contracts";
import { itemFromFields, planAutoApply } from "./apply";

const owner = "00000000-0000-4000-8000-0000000000a1";

const fields = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({
  docType: "bill",
  providerName: "Northgate Utilities",
  category: "utilities",
  insuranceType: null,
  amountDueCents: 12000,
  previousAmountCents: null,
  dueDate: "2026-11-15",
  renewalDate: null,
  cancelByDate: null,
  decisionByDate: null,
  frequency: "monthly",
  autoRenews: null,
  accountLast4: null,
  providerDomain: null,
  ...over,
});

describe("itemFromFields mappings", () => {
  it("debt becomes a loan, income an inflow, others a bill", () => {
    const kind = (category: ExtractedFields["category"]) => {
      const r = itemFromFields(fields({ category }), { ownerUserId: owner });
      return r.ok ? [r.item.direction, r.item.kind] : r;
    };
    expect(kind("debt")).toEqual(["outflow", "loan"]);
    expect(kind("income")).toEqual(["inflow", "income"]);
    expect(kind("subscription")).toEqual(["outflow", "subscription"]);
    expect(kind("membership")).toEqual(["outflow", "membership"]);
    expect(kind("utilities")).toEqual(["outflow", "bill"]);
    expect(kind(null)).toEqual(["outflow", "bill"]);
  });

  it("sets the provider domain only when it is in the (confirmed) fields", () => {
    const withDomain = itemFromFields(fields({ providerDomain: "northgate-insurance.example" }), {
      ownerUserId: owner,
    });
    expect(withDomain.ok && withDomain.item.providerDomain).toBe("northgate-insurance.example");
    const without = itemFromFields(fields(), { ownerUserId: owner });
    expect(without.ok && without.item.providerDomain).toBeNull();
  });
});

describe("planAutoApply writes a strict subset", () => {
  it("an estimate replaced by an actual sets only the occurrence actual", () => {
    expect(planAutoApply("estimate_to_actual", fields({ cancelByDate: "2026-12-01" }))).toEqual({
      occurrenceActual: { dueDate: "2026-11-15", amountCents: 12000 },
    });
  });

  it("an identical notice writes nothing", () => {
    expect(planAutoApply("identical_notice", fields())).toEqual({ occurrenceActual: null });
  });

  it("without a date or amount there is nothing to write", () => {
    expect(planAutoApply("estimate_to_actual", fields({ dueDate: null }))).toEqual({
      occurrenceActual: null,
    });
    expect(planAutoApply("estimate_to_actual", fields({ amountDueCents: null }))).toEqual({
      occurrenceActual: null,
    });
  });
});
