// Review queue and applied changes (WP-14; BACKEND_PLAN §5.2, §7.8.2, §8.2, §8.3).
// A partner sees extracted items (fields and evidence quotes from the redacted text), never the emails: nothing
// here carries a message body (hard rule 7). The worker writes the same `ExtractedFields` shape.
import { z } from "zod";
import { Cents, IsoDate, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, Timestamp, Uuid } from "../common";
import { ITEM_CATEGORIES, ProviderDomain } from "../items";

const Money = Cents.min(0).max(100_000_000_000);

export const DOC_TYPES = [
  "bill",
  "statement",
  "renewal_notice",
  "price_change",
  "receipt",
  "enrollment_deadline",
  "payment_confirmation",
  "irrelevant",
] as const;
export const INSURANCE_TYPES = [
  "auto",
  "motorcycle",
  "health",
  "dental",
  "home",
  "renters",
  "life",
  "pet",
  "other",
] as const;
export const EXTRACTED_FREQUENCIES = [
  "monthly",
  "every_2_months",
  "quarterly",
  "every_6_months",
  "yearly",
  "one_time",
] as const;

/** The longest evidence quote (BACKEND_PLAN §7.8.2). */
export const MAX_EVIDENCE_QUOTE_CHARS = 140;

const extractedShape = {
  docType: z.enum(DOC_TYPES),
  providerName: z.string().min(1).max(120).nullable(),
  category: z.enum(ITEM_CATEGORIES).nullable(),
  insuranceType: z.enum(INSURANCE_TYPES).nullable(),
  amountDueCents: Money.nullable(),
  previousAmountCents: Money.nullable(),
  dueDate: IsoDate.nullable(),
  renewalDate: IsoDate.nullable(),
  cancelByDate: IsoDate.nullable(),
  decisionByDate: IsoDate.nullable(),
  frequency: z.enum(EXTRACTED_FREQUENCIES).nullable(),
  autoRenews: z.boolean().nullable(),
  /** Only the last 4 characters of an account or policy number (hard rule 7). */
  accountLast4: z
    .string()
    .regex(/^[0-9A-Za-z]{1,4}$/, "Last 4 characters only")
    .nullable(),
  /**
   * The provider's mail domain for matching future messages. The pipeline writes null: it is set only when a
   * person confirms it in the edit body (the sender domain is shown on the card), never copied automatically.
   */
  providerDomain: ProviderDomain.nullable(),
};

/**
 * The validated extraction, as stored in `extracted_items.fields` and shown in review. The worker must write
 * EVERY key (use null for "not found"; a missing key makes the row unreadable and it is skipped in lists).
 */
export const ExtractedFields = z.strictObject(extractedShape).meta({ id: "ExtractedFields" });
export type ExtractedFields = z.infer<typeof ExtractedFields>;

export const EvidenceQuote = z
  .object({ field: z.string().min(1).max(60), quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE_CHARS) })
  .meta({ id: "EvidenceQuote" });
export type EvidenceQuote = z.infer<typeof EvidenceQuote>;

export const REVIEW_SOURCES = ["email", "csv"] as const;
export const MATCH_TYPES = ["new", "update", "decision", "duplicate"] as const;
export const REVIEW_STATES = ["queued", "auto_applied", "confirmed", "edited", "ignored", "expired"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Where the item came from: the sender domain and subject, kept only because an item was extracted. */
export const ReviewMessage = z
  .object({
    fromDomain: z.string().max(253),
    subject: z.string().max(300).nullable(),
    receivedAt: Timestamp,
  })
  .meta({ id: "ReviewMessage" });
export type ReviewMessage = z.infer<typeof ReviewMessage>;

export const ReviewEffect = z
  .object({
    /** A sentence without amounts: numbers on screen come from `fields`, never from this text. */
    summary: z.string().max(300),
    /** Change in safe to spend if applied. Null until the plan service can compute it (Q-121). */
    planDelta: z.object({ safeToSpendCents: Cents }).nullable(),
  })
  .meta({ id: "ReviewEffect" });

export const ReviewItem = z
  .object({
    id: Uuid,
    source: z.enum(REVIEW_SOURCES),
    state: z.enum(REVIEW_STATES),
    matchType: z.enum(MATCH_TYPES),
    matchItemId: Uuid.nullable(),
    message: ReviewMessage.nullable(),
    fields: ExtractedFields,
    evidence: z.array(EvidenceQuote),
    /** True after an edit: the quotes describe the original extraction, not the corrected values. */
    evidenceStale: z.boolean(),
    effect: ReviewEffect,
    decidedBy: Uuid.nullable(),
    decidedAt: Timestamp.nullable(),
    appliedChangeId: Uuid.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "ReviewItem" });
export type ReviewItem = z.infer<typeof ReviewItem>;

export const ReviewItemParams = z.object({ hid: Uuid, id: Uuid });
export const ReviewListQuery = z.object({
  state: z.enum(REVIEW_STATES).default("queued"),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});
export const ReviewItemPage = z
  .object({ data: z.array(ReviewItem), nextCursor: z.string().nullable() })
  .meta({ id: "ReviewItemPage" });

/** `POST …/review-items/:id/edit`: corrected fields; the item is then applied as edited. */
export const EditReviewItem = z
  .object({
    fields: z
      .strictObject(Object.fromEntries(Object.entries(extractedShape).map(([k, v]) => [k, v.optional()])))
      .refine((v) => Object.keys(v).length > 0, "Send at least one field"),
  })
  .meta({ id: "EditReviewItem" });
export type EditReviewItem = z.infer<typeof EditReviewItem>;

// ===== Applied changes =====
export const APPLIED_ORIGINS = ["email", "csv", "proposal", "user", "engine"] as const;

export const AppliedChange = z
  .object({
    id: Uuid,
    origin: z.enum(APPLIED_ORIGINS),
    entityType: z.string(),
    entityId: Uuid,
    /** The item's name, for the "Applied automatically" list. Null when it no longer exists. */
    entityName: z.string().nullable(),
    /** The values the change replaced (null when it created the entity) and the values it wrote. */
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()),
    /** Null = applied automatically. */
    appliedBy: Uuid.nullable(),
    appliedAt: Timestamp,
    undoUntil: Timestamp.nullable(),
    undoneAt: Timestamp.nullable(),
    undoneBy: Uuid.nullable(),
    /** True while the change can still be undone (inside `undoUntil` and not undone yet). */
    undoable: z.boolean(),
  })
  .meta({ id: "AppliedChange" });
export type AppliedChange = z.infer<typeof AppliedChange>;

export const AppliedChangeParams = z.object({ hid: Uuid, id: Uuid });
export const AppliedChangeListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});
export const AppliedChangePage = z
  .object({ data: z.array(AppliedChange), nextCursor: z.string().nullable() })
  .meta({ id: "AppliedChangePage" });

/** Result of confirm / edit / ignore. `appliedChange` is null when nothing changed (ignore, duplicate). */
export const ReviewDecision = z
  .object({
    item: ReviewItem,
    appliedChange: AppliedChange.nullable(),
    /** Safe to spend after the decision, from a fresh engine read; null when the plan is not ready yet. */
    plan: z.object({ safeToSpendCents: Cents }).nullable(),
  })
  .meta({ id: "ReviewDecision" });
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/** How long a change can be undone (BACKEND_PLAN §7.8.2). */
export const UNDO_WINDOW_DAYS = 30;

// ===== Sender rules (BACKEND_PLAN §8.2) =====
export const SENDER_RULES = ["watch", "ignore"] as const;

/** A household's watch/ignore rule. The global seed list is not editable through the API. */
export const SenderRule = z
  .object({
    id: Uuid,
    domain: ProviderDomain,
    rule: z.enum(SENDER_RULES),
    categoryHint: z.enum(ITEM_CATEGORIES).nullable(),
    createdBy: Uuid.nullable(),
  })
  .meta({ id: "SenderRule" });
export type SenderRule = z.infer<typeof SenderRule>;

/** `POST …/sender-rules`: creates the rule, or changes the rule of an existing domain. */
export const PutSenderRule = z
  .object({
    domain: ProviderDomain,
    rule: z.enum(SENDER_RULES),
    categoryHint: z.enum(ITEM_CATEGORIES).nullish(),
  })
  .strict()
  .meta({ id: "PutSenderRule" });
export type PutSenderRule = z.infer<typeof PutSenderRule>;

export const SenderRuleList = z.object({ data: z.array(SenderRule) }).meta({ id: "SenderRuleList" });
