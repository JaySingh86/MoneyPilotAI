import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../schemas/extraction.v1";
import { nearestUpcoming, parseAmountsCents, parseDates, validateExtraction } from "./validate";

// Security review fixes M1 (yearless dates), M2 (amount forms), M3 (free-text fields) and L6 (loose dates).

const base: ExtractionResult = {
  doc_type: "bill",
  provider_name: "Pacific Electric",
  category: "utilities",
  insurance_type: null,
  amount_due_cents: 14218,
  previous_amount_cents: null,
  due_date: "2027-03-14",
  renewal_date: null,
  cancel_by_date: null,
  decision_by_date: null,
  frequency: null,
  auto_renews: null,
  account_last4: null,
  evidence: [
    { field: "amount_due_cents", quote: "Amount due: $142.18" },
    { field: "due_date", quote: "Please pay by March 14, 2027." },
  ],
};
const SOURCE =
  "Subject: Pacific Electric bill\nAmount due: $142.18\nPlease pay by March 14, 2027.\nAccount ending 4821";
const ctx = { sourceText: SOURCE, receivedAt: Temporal.PlainDate.from("2027-03-01"), truncated: false };
const result = (e: Partial<ExtractionResult>, c = ctx) => validateExtraction({ ...base, ...e }, c);
const rules = (e: Partial<ExtractionResult>, c = ctx): string[] =>
  result(e, c).failures.map((f) => `${f.rule}:${f.field}`);

describe("M1: a yearless date must equal the single nearest upcoming date", () => {
  const received = Temporal.PlainDate.from("2026-02-20");
  const yearless = {
    sourceText: "Subject: Pacific Electric\nAmount due: $142.18\nDue March 14",
    receivedAt: received,
    truncated: false,
  };
  const evidence = [
    { field: "amount_due_cents", quote: "Amount due: $142.18" },
    { field: "due_date", quote: "Due March 14" },
  ];

  it("nearestUpcoming picks the first occurrence on or after the received date", () => {
    expect(nearestUpcoming(received, 3, 14)?.toString()).toBe("2026-03-14");
    expect(nearestUpcoming(Temporal.PlainDate.from("2026-03-14"), 3, 14)?.toString()).toBe("2026-03-14");
    expect(nearestUpcoming(Temporal.PlainDate.from("2026-03-15"), 3, 14)?.toString()).toBe("2027-03-14");
    expect(nearestUpcoming(Temporal.PlainDate.from("2027-03-01"), 2, 29)?.toString()).toBe("2028-02-29");
  });

  it("accepts the nearest upcoming date", () => {
    expect(rules({ due_date: "2026-03-14", evidence }, yearless)).toEqual([]);
  });

  it("rejects the same month and day a year later (the 2027-03-14 case)", () => {
    expect(rules({ due_date: "2027-03-14", evidence }, yearless)).toContain("date_mismatch:due_date");
  });

  it("rejects the previous year too", () => {
    expect(rules({ due_date: "2025-03-14", evidence }, yearless)).toContain("date_mismatch:due_date");
  });

  it("an explicit year in the quote is matched exactly, not by proximity", () => {
    expect(rules({ due_date: "2027-03-14" })).toEqual([]);
    expect(rules({ due_date: "2026-03-14" })).toContain("date_mismatch:due_date");
  });
});

describe("M2: amount forms", () => {
  it("accepts $-prefixed amounts", () => {
    expect(parseAmountsCents("$1,234.56")).toEqual([123456]);
    expect(parseAmountsCents("$142")).toEqual([14200]);
    expect(parseAmountsCents("pay $142.")).toEqual([14200]);
  });

  it("accepts a bare n.nn only after an amount keyword", () => {
    expect(parseAmountsCents("Amount due: 142.18")).toEqual([14218]);
    expect(parseAmountsCents("Total 1,234.56")).toEqual([123456]);
    expect(parseAmountsCents("Balance: 90.00")).toEqual([9000]);
    expect(parseAmountsCents("Renewal premium is 300.50")).toEqual([30050]);
    expect(parseAmountsCents("Payment of 25.00")).toEqual([2500]);
  });

  it.each([
    "Ref 5.99",
    "Invoice 2024.11",
    "14.03.2026",
    "10.20.30.40",
    "1234.56",
    "Total 14.03.2026",
    "Total 10.20.30.40",
  ])("does not ground an amount from %s", (text) => {
    expect(parseAmountsCents(text)).toEqual([]);
  });

  it("does not read $142.185 as $142.18 or $142", () => {
    expect(parseAmountsCents("$142.185")).toEqual([]);
    expect(parseAmountsCents("$1,234.5678")).toEqual([]);
  });

  it("a number that is only in a reference cannot validate the field", () => {
    const source = `${SOURCE}\nRef 142.18`;
    const e = {
      evidence: [
        { field: "amount_due_cents", quote: "Ref 142.18" },
        base.evidence[1] as { field: string; quote: string },
      ],
    };
    expect(rules(e, { ...ctx, sourceText: source })).toContain("amount_mismatch:amount_due_cents");
  });
});

describe("L6: loose date forms", () => {
  it("does not read '1/2 off' as a date", () => {
    expect(parseDates("Save 1/2 off everything")).toEqual([]);
    expect(parseDates("1/2 OFF")).toEqual([]);
  });

  it("does not read the verb 'may' as a month", () => {
    expect(parseDates("you may 5 times")).toEqual([]);
    expect(parseDates("we may 12 days")).toEqual([]);
  });

  it("still reads May as a month when capitalised", () => {
    expect(parseDates("due May 5")).toEqual([{ year: null, month: 5, day: 5 }]);
    expect(parseDates("due 5 May 2027")).toEqual([{ year: 2027, month: 5, day: 5 }]);
  });

  it("still reads a plain m/d date", () => {
    expect(parseDates("due 3/14")).toEqual([{ year: null, month: 3, day: 14 }]);
  });
});

describe("M3: free-text and advisory fields", () => {
  it("accepts a provider name that appears in the source, ignoring case", () => {
    expect(rules({ provider_name: "PACIFIC ELECTRIC" })).toEqual([]);
  });

  it("rejects a provider name that is not in the source", () => {
    expect(rules({ provider_name: "Attacker Corp" })).toEqual(["provider_name_not_in_source:provider_name"]);
  });

  it("rejects a provider name over 80 characters", () => {
    const long = `Pacific Electric ${"x".repeat(70)}`;
    expect(rules({ provider_name: long }, { ...ctx, sourceText: `${SOURCE}\n${long}` })).toEqual([
      "provider_name_invalid:provider_name",
    ]);
  });

  it.each([
    "Pacific Electric https://evil.example",
    "www.evil.example Pacific Electric",
    "Pacific Electric\u0000",
    "Pacific\nElectric",
  ])("rejects a provider name with a URL or control character: %j", (name) => {
    expect(rules({ provider_name: name }, { ...ctx, sourceText: `${SOURCE}\n${name}` })).toContain(
      "provider_name_invalid:provider_name",
    );
  });

  it("rejects an empty provider name", () => {
    expect(rules({ provider_name: "" })).toContain("provider_name_invalid:provider_name");
  });

  it("accepts account_last4 that matches the pattern and appears in the source", () => {
    expect(rules({ account_last4: "4821" })).toEqual([]);
    expect(rules({ account_last4: "48" }, { ...ctx, sourceText: `${SOURCE} 48` })).toEqual([]);
  });

  it("rejects account_last4 that is not in the source", () => {
    expect(rules({ account_last4: "9999" })).toEqual(["account_last4_not_in_source:account_last4"]);
  });

  it.each(["", "48 1", "48;1", "<b>", "a\nb"])(
    "rejects account_last4 %j with a bad character set",
    (value) => {
      expect(rules({ account_last4: value }, { ...ctx, sourceText: `${SOURCE} ${value}` })).toContain(
        "account_last4_invalid:account_last4",
      );
    },
  );

  it("rejects account_last4 over 4 characters", () => {
    expect(rules({ account_last4: "48211" }, { ...ctx, sourceText: `${SOURCE} 48211` })).toContain(
      "account_last4_too_long:account_last4",
    );
  });

  it("marks auto_renews and frequency advisory when they carry no evidence", () => {
    const r = result({ auto_renews: true, frequency: "monthly" });
    expect(r.ok).toBe(true);
    expect(r.advisoryFields).toEqual(["frequency", "auto_renews"]);
  });

  it("clears the advisory mark when a verbatim quote supports the field", () => {
    const source = `${SOURCE}\nYour plan renews automatically every month.`;
    const evidence = [
      ...base.evidence,
      { field: "auto_renews", quote: "renews automatically" },
      { field: "frequency", quote: "every month" },
    ];
    const r = result({ auto_renews: true, frequency: "monthly", evidence }, { ...ctx, sourceText: source });
    expect(r).toEqual({ ok: true, failures: [], advisoryFields: [] });
  });

  it("fails when the quote for auto_renews or frequency is not in the source", () => {
    const evidence = [...base.evidence, { field: "auto_renews", quote: "never in the email" }];
    expect(rules({ auto_renews: true, evidence })).toContain("evidence_not_verbatim:auto_renews");
  });

  it("null auto_renews and frequency are not advisory", () => {
    expect(result({}).advisoryFields).toEqual([]);
  });
});
