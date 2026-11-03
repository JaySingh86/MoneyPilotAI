import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../schemas/extraction.v1";
import { parseAmountsCents, parseDates, validateExtraction } from "./validate";

const RECEIVED = Temporal.PlainDate.from("2027-03-01");
const SOURCE = [
  "Subject: Your Pacific Electric bill",
  "Amount due: $234.56",
  "Account ending in 48211",
  "Please pay by March 14, 2027.",
  "Your policy renews on 4/20/27 and you may cancel by 20 April.",
].join("\n");

function extraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    doc_type: "bill",
    provider_name: "Pacific Electric",
    category: "utilities",
    insurance_type: null,
    amount_due_cents: 23456,
    previous_amount_cents: null,
    due_date: "2027-03-14",
    renewal_date: null,
    cancel_by_date: null,
    decision_by_date: null,
    frequency: null,
    auto_renews: null,
    account_last4: null,
    evidence: [
      { field: "amount_due_cents", quote: "Amount due: $234.56" },
      { field: "due_date", quote: "Please pay by March 14, 2027." },
    ],
    ...overrides,
  };
}

const ctx = { sourceText: SOURCE, receivedAt: RECEIVED, truncated: false };
const rules = (e: ExtractionResult, c = ctx): string[] =>
  validateExtraction(e, c).failures.map((f) => `${f.rule}:${f.field}`);

describe("parseAmountsCents", () => {
  it("reads the formats the spec names", () => {
    expect(parseAmountsCents("$1,234.56")).toEqual([123456]);
    expect(parseAmountsCents("Total 1234.56")).toEqual([123456]);
    expect(parseAmountsCents("$142")).toEqual([14200]);
    expect(parseAmountsCents("$5.5")).toEqual([550]);
  });
  it("returns every amount in a quote", () => {
    expect(parseAmountsCents("from $9.99 to $12.99")).toEqual([999, 1299]);
  });
  it("ignores bare integers such as account digits", () => {
    expect(parseAmountsCents("Account 12345678")).toEqual([]);
  });
});

describe("parseDates", () => {
  it("reads ISO, US numeric and month-name forms", () => {
    expect(parseDates("2027-03-14")).toEqual([{ year: 2027, month: 3, day: 14 }]);
    expect(parseDates("03/14/2027")).toEqual([{ year: 2027, month: 3, day: 14 }]);
    expect(parseDates("3/14/27")).toEqual([{ year: 2027, month: 3, day: 14 }]);
    expect(parseDates("March 14, 2027")).toEqual([{ year: 2027, month: 3, day: 14 }]);
    expect(parseDates("Mar 14th, 2027")).toEqual([{ year: 2027, month: 3, day: 14 }]);
    expect(parseDates("14 March 2027")).toEqual([{ year: 2027, month: 3, day: 14 }]);
  });
  it("keeps a missing year as null", () => {
    expect(parseDates("due 3/14")).toEqual([{ year: null, month: 3, day: 14 }]);
    expect(parseDates("by April 20")).toEqual([{ year: null, month: 4, day: 20 }]);
  });
  it("drops impossible dates", () => {
    expect(parseDates("02/30/2027")).toEqual([]);
    expect(parseDates("13/45/2027")).toEqual([]);
  });
});

describe("validateExtraction", () => {
  it("accepts a grounded extraction", () => {
    expect(validateExtraction(extraction(), ctx)).toEqual({ ok: true, failures: [], advisoryFields: [] });
  });

  describe("rule 1: evidence", () => {
    it("requires a quote for every non-null amount and date", () => {
      expect(rules(extraction({ evidence: [] }))).toEqual([
        "evidence_missing:amount_due_cents",
        "evidence_missing:due_date",
      ]);
    });
    it("blocks a hallucinated quote that is not in the source", () => {
      const e = extraction({
        evidence: [
          { field: "amount_due_cents", quote: "Amount due: $9,999.00" },
          { field: "due_date", quote: "Please pay by March 14, 2027." },
        ],
      });
      expect(rules(e)).toContain("evidence_not_verbatim:amount_due_cents");
    });
    it("tolerates a line wrap inside a quote", () => {
      const wrapped = {
        ...ctx,
        sourceText: "Pacific Electric\nAmount due:\n   $234.56\nPlease pay by March 14,\n2027.",
      };
      expect(rules(extraction(), wrapped)).toEqual([]);
    });
    it("rejects quotes over 140 characters", () => {
      const long = `Amount due: $234.56 ${"x".repeat(130)}`;
      const e = extraction({
        evidence: [
          { field: "amount_due_cents", quote: long },
          { field: "due_date", quote: "Please pay by March 14, 2027." },
        ],
      });
      expect(rules(e, { ...ctx, sourceText: `${SOURCE}\n${long}` })).toContain(
        "evidence_too_long:amount_due_cents",
      );
    });
    it("rejects evidence for a field that is not an amount or date", () => {
      const e = extraction({
        evidence: [...extraction().evidence, { field: "provider_name", quote: "Pacific Electric" }],
      });
      expect(rules(e)).toContain("evidence_unknown_field:provider_name");
    });
    it("rejects an empty quote", () => {
      const e = extraction({
        evidence: [
          { field: "amount_due_cents", quote: "" },
          { field: "due_date", quote: "Please pay by March 14, 2027." },
        ],
      });
      expect(rules(e)).toContain("evidence_not_verbatim:amount_due_cents");
    });
  });

  describe("rule 2: quote equals field", () => {
    it("fails when the amount differs from the quote", () => {
      expect(rules(extraction({ amount_due_cents: 100 }))).toEqual(["amount_mismatch:amount_due_cents"]);
    });
    it("fails when the date differs from the quote", () => {
      expect(rules(extraction({ due_date: "2027-03-15" }))).toEqual(["date_mismatch:due_date"]);
    });
    it("accepts US numeric dates and day-month dates", () => {
      const e = extraction({
        due_date: null,
        renewal_date: "2027-04-20",
        cancel_by_date: "2027-04-20",
        evidence: [
          { field: "amount_due_cents", quote: "Amount due: $234.56" },
          { field: "renewal_date", quote: "Your policy renews on 4/20/27" },
          { field: "cancel_by_date", quote: "cancel by 20 April." },
        ],
      });
      expect(rules(e)).toEqual([]);
    });
    it("rejects a yearless date more than a year from the received date", () => {
      const e = extraction({
        due_date: "2030-03-14",
        evidence: [
          ...extraction().evidence.slice(0, 1),
          { field: "due_date", quote: "Please pay by March 14" },
        ],
      });
      expect(rules(e, { ...ctx, sourceText: `${SOURCE}\nPlease pay by March 14` })).toContain(
        "date_mismatch:due_date",
      );
    });
    it("rejects a malformed ISO date", () => {
      expect(rules(extraction({ due_date: "2027-02-30" }))).toContain("date_mismatch:due_date");
    });
  });

  describe("rule 3: date plausibility", () => {
    const withDate = (iso: string, quote: string): [ExtractionResult, typeof ctx] => [
      extraction({
        due_date: iso,
        evidence: [
          { field: "amount_due_cents", quote: "Amount due: $234.56" },
          { field: "due_date", quote },
        ],
      }),
      { ...ctx, sourceText: `${SOURCE}\n${quote}` },
    ];
    it("allows -30 and +400 days", () => {
      expect(rules(...withDate("2027-01-30", "Due 2027-01-30"))).toEqual([]);
      expect(rules(...withDate("2028-04-04", "Due 2028-04-04"))).toEqual([]);
    });
    it("rejects -31 and +401 days", () => {
      expect(rules(...withDate("2027-01-29", "Due 2027-01-29"))).toEqual(["date_implausible:due_date"]);
      expect(rules(...withDate("2028-04-05", "Due 2028-04-05"))).toEqual(["date_implausible:due_date"]);
    });
  });

  describe("rule 4: amount plausibility", () => {
    it("rejects a subscription of $500 or more", () => {
      const e = extraction({
        category: "subscription",
        amount_due_cents: 50001,
        evidence: [{ field: "amount_due_cents", quote: "Amount due: $500.01" }],
        due_date: null,
      });
      expect(rules(e, { ...ctx, sourceText: `${SOURCE}\nAmount due: $500.01` })).toEqual([
        "amount_implausible:amount_due_cents",
      ]);
    });
    it("rejects a negative amount", () => {
      const e = extraction({
        amount_due_cents: -100,
        due_date: null,
        evidence: [{ field: "amount_due_cents", quote: "Amount due: $234.56" }],
      });
      expect(rules(e)).toContain("amount_implausible:amount_due_cents");
    });
    it("uses a default ceiling when the category is null", () => {
      const e = extraction({ category: null });
      expect(rules(e)).toEqual([]);
    });
  });

  it("rule 5: account_last4 is at most 4 characters", () => {
    expect(rules(extraction({ account_last4: "4821" }))).toEqual([]);
    expect(rules(extraction({ account_last4: "48211" }))).toEqual(["account_last4_too_long:account_last4"]);
  });

  it("rule 6: a truncated email never validates", () => {
    expect(rules(extraction(), { ...ctx, truncated: true })).toEqual(["truncated:source"]);
  });

  it("an irrelevant result must carry no values", () => {
    const clean = extraction({
      doc_type: "irrelevant",
      amount_due_cents: null,
      due_date: null,
      evidence: [],
    });
    expect(rules(clean)).toEqual([]);
    expect(rules(extraction({ doc_type: "irrelevant" }))).toContain("irrelevant_has_values:doc_type");
  });

  it("failure details never contain amounts or dates", () => {
    const result = validateExtraction(extraction({ amount_due_cents: 424242 }), ctx);
    expect(JSON.stringify(result)).not.toMatch(/424242|23456|2027/);
  });
});
