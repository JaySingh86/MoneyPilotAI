// email.decide (BACKEND_PLAN §7.8.2 "Auto-apply policy"): pure, so every rule is a table row. The policy only
// ever says "auto-apply" when ALL of the conditions hold; anything else is a review with the reasons.
import { describe, expect, it } from "vitest";
import type { ExtractedFields } from "@mp/contracts";
import {
  AUTO_APPLY_TOLERANCE_PERCENT,
  decideExtraction,
  type DecideInput,
  type ExpectedItem,
  type ReviewReason,
} from "./decide";

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
  frequency: null,
  autoRenews: null,
  accountLast4: "4821",
  providerDomain: null,
  ...over,
});

const estimated: ExpectedItem = {
  amountType: "estimated",
  expectedAmountCents: 10000,
  expectedDate: "2026-11-15",
  renewal: null,
};
const fixed: ExpectedItem = {
  amountType: "fixed",
  expectedAmountCents: 12000,
  expectedDate: "2026-11-15",
  renewal: null,
};

/** A message that passes every gate; each test flips one thing. */
const green = (over: Partial<DecideInput> = {}): DecideInput => ({
  outcome: { status: "ok", validation: { ok: true, advisoryFields: [] } },
  authentication: { dmarcAligned: true },
  injectionSuspected: false,
  domainMatch: true,
  matchedItemConfirmed: true,
  senderFirstSeen: false,
  autoApplyEnabled: true,
  fields: fields(),
  item: estimated,
  ...over,
});

const reasons = (input: DecideInput): readonly ReviewReason[] => {
  const d = decideExtraction(input);
  return d.action === "review" ? d.reasons : [];
};

describe("auto-apply", () => {
  it("applies an actual statement amount within 50% of the estimate", () => {
    expect(decideExtraction(green())).toEqual({ action: "auto_apply", change: "estimate_to_actual" });
  });

  it("applies a notice whose amount and date are identical to what we expect", () => {
    expect(decideExtraction(green({ item: fixed }))).toEqual({
      action: "auto_apply",
      change: "identical_notice",
    });
    expect(
      decideExtraction(
        green({
          item: {
            amountType: "fixed",
            expectedAmountCents: 16800,
            expectedDate: "2027-01-09",
            renewal: {
              renewalDate: "2027-01-09",
              cancelByDate: null,
              decisionByDate: null,
              previousAmountCents: null,
              autoRenews: null,
            },
          },
          fields: fields({
            docType: "renewal_notice",
            amountDueCents: 16800,
            dueDate: null,
            renewalDate: "2027-01-09",
          }),
        }),
      ),
    ).toEqual({ action: "auto_apply", change: "identical_notice" });
  });

  it("uses a 50% band on the estimate, inclusive, in integer math", () => {
    expect(AUTO_APPLY_TOLERANCE_PERCENT).toBe(50);
    const at = (amountDueCents: number) =>
      decideExtraction(green({ fields: fields({ amountDueCents }) })).action;
    expect(at(15000)).toBe("auto_apply"); // +50%
    expect(at(15001)).toBe("review");
    expect(at(5000)).toBe("auto_apply"); // -50%
    expect(at(4999)).toBe("review");
  });

  it("the estimate case needs the bill's date to be the date we expect (M2)", () => {
    expect(reasons(green({ fields: fields({ dueDate: "2026-11-22" }) }))).toEqual(["not_an_expected_change"]);
    expect(reasons(green({ fields: fields({ dueDate: null }) }))).toEqual(["not_an_expected_change"]);
  });
});

describe("renewal fields never auto-apply when they would change anything (M2)", () => {
  const renewalOf = (over: Partial<NonNullable<ExpectedItem["renewal"]>> = {}) => ({
    renewalDate: null,
    cancelByDate: null,
    decisionByDate: null,
    previousAmountCents: null,
    autoRenews: null,
    ...over,
  });
  const changes: [string, Partial<ExtractedFields>][] = [
    ["cancelByDate", { cancelByDate: "2026-12-20" }],
    ["decisionByDate", { decisionByDate: "2026-12-01" }],
    ["autoRenews", { autoRenews: false }],
    ["previousAmountCents", { previousAmountCents: 9000 }],
    ["renewalDate", { renewalDate: "2027-03-01" }],
  ];

  it.each(changes)("a new %s goes to review", (_name, over) => {
    expect(reasons(green({ fields: fields(over) }))).toContain("renewal_fields_change");
    expect(reasons(green({ item: fixed, fields: fields(over) }))).toContain("renewal_fields_change");
  });

  it.each(changes)("a %s that equals what the item already has is no change", (_name, over) => {
    const expected = renewalOf({
      renewalDate: over.renewalDate ?? null,
      cancelByDate: over.cancelByDate ?? null,
      decisionByDate: over.decisionByDate ?? null,
      previousAmountCents: over.previousAmountCents ?? null,
      autoRenews: over.autoRenews ?? null,
    });
    expect(reasons(green({ item: { ...estimated, renewal: expected }, fields: fields(over) }))).not.toContain(
      "renewal_fields_change",
    );
  });

  it("a differing existing value is a change too", () => {
    const item = { ...estimated, renewal: renewalOf({ cancelByDate: "2026-12-01" }) };
    expect(reasons(green({ item, fields: fields({ cancelByDate: "2026-12-20" }) }))).toContain(
      "renewal_fields_change",
    );
  });

  it("a notice that says nothing about renewal fields is not a renewal change", () => {
    expect(reasons(green())).toEqual([]);
  });
});

describe("everything else goes to review", () => {
  const cases: [string, Partial<DecideInput>, ReviewReason][] = [
    [
      "validation failed",
      { outcome: { status: "ok", validation: { ok: false, advisoryFields: [] } } },
      "validation_failed",
    ],
    ["a refusal", { outcome: { status: "refusal" } }, "model_refused"],
    ["invalid output", { outcome: { status: "invalid_output" } }, "invalid_output"],
    [
      "advisory fields (frequency / auto_renews without a quote)",
      { outcome: { status: "ok", validation: { ok: true, advisoryFields: ["frequency"] } } },
      "advisory_fields",
    ],
    ["no aligned DMARC pass", { authentication: { dmarcAligned: false } }, "sender_not_authenticated"],
    ["injection suspected", { injectionSuspected: true }, "injection_suspected"],
    ["not a provider-domain match", { domainMatch: false }, "no_domain_match"],
    ["the matched item is not confirmed", { matchedItemConfirmed: false }, "item_not_confirmed"],
    ["the sender is first-seen for this item", { senderFirstSeen: true }, "first_seen_sender"],
    ["automatic updates are off for the household", { autoApplyEnabled: false }, "auto_apply_disabled"],
    ["no item to compare with", { item: null }, "no_matched_item"],
    ["an ok outcome without fields", { fields: null }, "invalid_output"],
  ];

  it.each(cases)("%s", (_name, over, reason) => {
    expect(decideExtraction(green(over)).action).toBe("review");
    expect(reasons(green(over))).toContain(reason);
  });

  it("a price increase on a fixed item is a review", () => {
    expect(reasons(green({ item: fixed, fields: fields({ amountDueCents: 12100 }) }))).toEqual([
      "not_an_expected_change",
    ]);
  });

  it("a different date on an otherwise identical notice is a review", () => {
    expect(reasons(green({ item: fixed, fields: fields({ dueDate: "2026-11-20" }) }))).toEqual([
      "not_an_expected_change",
    ]);
  });

  it("a missing amount cannot be auto-applied", () => {
    expect(reasons(green({ fields: fields({ amountDueCents: null }) }))).toContain("not_an_expected_change");
    expect(reasons(green({ item: fixed, fields: fields({ amountDueCents: null }) }))).toContain(
      "not_an_expected_change",
    );
  });

  it("an estimate of zero or none cannot anchor the 50% band", () => {
    expect(reasons(green({ item: { ...estimated, expectedAmountCents: 0 } }))).toContain(
      "not_an_expected_change",
    );
    expect(reasons(green({ item: { ...estimated, expectedAmountCents: null } }))).toContain(
      "not_an_expected_change",
    );
  });

  it("only bills, statements and renewal notices can auto-apply", () => {
    for (const docType of [
      "price_change",
      "receipt",
      "enrollment_deadline",
      "payment_confirmation",
      "irrelevant",
    ] as const) {
      expect(reasons(green({ fields: fields({ docType }) })), docType).toContain("doc_type_not_auto");
    }
  });

  it("reports every reason at once, in a stable order, without any values", () => {
    const all = reasons(
      green({
        outcome: { status: "ok", validation: { ok: false, advisoryFields: ["autoRenews"] } },
        authentication: { dmarcAligned: false },
        injectionSuspected: true,
        domainMatch: false,
        senderFirstSeen: true,
      }),
    );
    expect(all).toEqual([
      "validation_failed",
      "advisory_fields",
      "sender_not_authenticated",
      "injection_suspected",
      "no_domain_match",
      "first_seen_sender",
    ]);
  });

  it("is one flip away from review for every gate (no gate is optional)", () => {
    expect(decideExtraction(green()).action).toBe("auto_apply");
    for (const [name, over] of cases) {
      expect(decideExtraction(green(over)).action, name).toBe("review");
    }
  });
});
