import { describe, expect, it } from "vitest";
import { ExtractedFields, type EvidenceQuote } from "@mp/contracts";
import type { ExtractionResult } from "@mp/ai/extract";
import { EVIDENCE_FIELD_NAMES, mapExtraction } from "./map";

const full: ExtractionResult = {
  doc_type: "renewal_notice",
  provider_name: "Northgate Home Insurance",
  category: "insurance",
  insurance_type: "renters",
  amount_due_cents: 16800,
  previous_amount_cents: 14900,
  due_date: "2026-12-20",
  renewal_date: "2027-01-09",
  cancel_by_date: "2026-12-20",
  decision_by_date: "2026-11-13",
  frequency: "yearly",
  auto_renews: true,
  account_last4: "4821",
  evidence: [
    { field: "amount_due_cents", quote: "New premium: $168.00" },
    { field: "previous_amount_cents", quote: "was $149.00" },
    { field: "due_date", quote: "Due December 20, 2026" },
    { field: "renewal_date", quote: "renews on January 9, 2027" },
    { field: "cancel_by_date", quote: "Cancel by December 20, 2026" },
    { field: "decision_by_date", quote: "Decide by November 13, 2026" },
    { field: "frequency", quote: "per year" },
    { field: "auto_renews", quote: "Autopay is on" },
  ],
};

describe("mapExtraction: WP-11 snake_case to the review contract's camelCase", () => {
  it("maps every field explicitly, and the result is a valid ExtractedFields with every key", () => {
    const m = mapExtraction(full);
    expect(m.fields).toEqual({
      docType: "renewal_notice",
      providerName: "Northgate Home Insurance",
      category: "insurance",
      insuranceType: "renters",
      amountDueCents: 16800,
      previousAmountCents: 14900,
      dueDate: "2026-12-20",
      renewalDate: "2027-01-09",
      cancelByDate: "2026-12-20",
      decisionByDate: "2026-11-13",
      frequency: "yearly",
      autoRenews: true,
      accountLast4: "4821",
      providerDomain: null,
    });
    expect(ExtractedFields.safeParse(m.fields).success).toBe(true);
    expect(m.dropped).toEqual([]);
  });

  it("covers exactly the contract's keys (a new contract field cannot be missed silently)", () => {
    const keys = Object.keys(mapExtraction(full).fields).sort();
    expect(keys).toEqual(Object.keys(ExtractedFields.shape).sort());
  });

  it("renames the evidence fields, and keeps the quotes as they are", () => {
    const m = mapExtraction(full);
    expect(m.evidence).toEqual<EvidenceQuote[]>([
      { field: "amountDueCents", quote: "New premium: $168.00" },
      { field: "previousAmountCents", quote: "was $149.00" },
      { field: "dueDate", quote: "Due December 20, 2026" },
      { field: "renewalDate", quote: "renews on January 9, 2027" },
      { field: "cancelByDate", quote: "Cancel by December 20, 2026" },
      { field: "decisionByDate", quote: "Decide by November 13, 2026" },
      { field: "frequency", quote: "per year" },
      { field: "autoRenews", quote: "Autopay is on" },
    ]);
  });

  it("every WP-11 evidence field has a mapping, and each maps to a real contract field", () => {
    for (const camel of Object.values(EVIDENCE_FIELD_NAMES)) {
      expect(Object.keys(ExtractedFields.shape)).toContain(camel);
    }
    expect(Object.keys(EVIDENCE_FIELD_NAMES).sort()).toEqual(
      [
        "amount_due_cents",
        "auto_renews",
        "cancel_by_date",
        "decision_by_date",
        "due_date",
        "frequency",
        "previous_amount_cents",
        "renewal_date",
      ].sort(),
    );
  });

  it("leaves out evidence for an unknown field, an empty quote and a quote over 140 characters", () => {
    const m = mapExtraction({
      ...full,
      evidence: [
        { field: "provider_name", quote: "Northgate" },
        { field: "due_date", quote: "   " },
        { field: "renewal_date", quote: "x".repeat(141) },
        { field: "amount_due_cents", quote: "  $168.00  " },
      ],
    });
    expect(m.evidence).toEqual([{ field: "amountDueCents", quote: "$168.00" }]);
  });

  it("never carries a provider domain, whatever the model said (the schema has none; extra keys are not copied)", () => {
    const withDomain = { ...full, provider_domain: "evil.example" } as unknown as ExtractionResult;
    expect(mapExtraction(withDomain).fields.providerDomain).toBeNull();
    expect(mapExtraction(full).fields.providerDomain).toBeNull();
  });

  it("drops a value the contract cannot hold, and says so (the pipeline then reviews it, never auto-applies)", () => {
    const m = mapExtraction({
      ...full,
      amount_due_cents: -500,
      due_date: "2026-02-31",
      renewal_date: "not a date",
    });
    expect(m.fields.amountDueCents).toBeNull();
    expect(m.fields.dueDate).toBeNull();
    expect(m.fields.renewalDate).toBeNull();
    expect(m.dropped.sort()).toEqual(["amountDueCents", "dueDate", "renewalDate"]);
  });

  it("a soft field the contract refuses (a last 4 with a hyphen, an over-long name) is dropped without failing the item", () => {
    const m = mapExtraction({ ...full, account_last4: "12-3", provider_name: "N".repeat(300) });
    expect(m.fields.accountLast4).toBeNull();
    expect(m.fields.providerName).toHaveLength(120);
    expect(m.dropped).toEqual([]);
  });

  it("an empty provider name becomes null, not an empty string", () => {
    expect(mapExtraction({ ...full, provider_name: "   " }).fields.providerName).toBeNull();
  });
});
