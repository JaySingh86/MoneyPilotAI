import { describe, expect, it } from "vitest";
import { EditReviewItem, ExtractedFields, ReviewListQuery } from "./index";

const fields = {
  docType: "renewal_notice",
  providerName: "Northgate Home Insurance",
  category: "insurance",
  insuranceType: "renters",
  amountDueCents: 16800,
  previousAmountCents: 14900,
  dueDate: null,
  renewalDate: "2027-01-09",
  cancelByDate: null,
  decisionByDate: null,
  frequency: null,
  autoRenews: null,
  accountLast4: "4821",
  providerDomain: null,
};

describe("review contracts", () => {
  it("accepts the §8.3 fields and rejects floats, long account numbers and unknown keys", () => {
    expect(ExtractedFields.safeParse(fields).success).toBe(true);
    expect(ExtractedFields.safeParse({ ...fields, amountDueCents: 168.5 }).success).toBe(false);
    expect(ExtractedFields.safeParse({ ...fields, accountLast4: "12345678" }).success).toBe(false);
    expect(ExtractedFields.safeParse({ ...fields, body: "email text" }).success).toBe(false);
    expect(ExtractedFields.safeParse({ ...fields, renewalDate: "2027-02-30" }).success).toBe(false);
  });

  it("an edit carries at least one known field and never invents defaults", () => {
    expect(EditReviewItem.safeParse({ fields: {} }).success).toBe(false);
    expect(EditReviewItem.safeParse({ fields: { amountDueCents: 16500 } }).success).toBe(true);
    expect(EditReviewItem.parse({ fields: { amountDueCents: 16500 } })).toEqual({
      fields: { amountDueCents: 16500 },
    });
    expect(EditReviewItem.safeParse({ fields: { subject: "x" } }).success).toBe(false);
  });

  it("lists the queue by default", () => {
    expect(ReviewListQuery.parse({})).toMatchObject({ state: "queued", limit: 50 });
  });
});
