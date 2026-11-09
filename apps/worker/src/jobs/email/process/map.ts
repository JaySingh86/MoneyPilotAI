// The one place the WP-11 extraction (snake_case, `ExtractionResult`) becomes the review contract (camelCase,
// `ExtractedFields` and `EvidenceQuote`, WP-14). Explicit, field by field: a renamed or added field fails a test here
// instead of silently dropping a value on the way to the review queue.
//
// This mapping never invents or changes a value. It copies, or it drops a value the contract cannot hold (and says
// so, so the pipeline sends the item to review instead of auto-applying). `providerDomain` is ALWAYS null: a domain
// the model supplied is never trusted, and only a person's edit sets it (WP-22, DESIGN_SPEC M3).
import { EvidenceQuote, ExtractedFields, MAX_EVIDENCE_QUOTE_CHARS } from "@mp/contracts";
import type { ExtractionResult } from "@mp/ai/extract";

/** WP-11 evidence field name -> the review contract's field name. Fields not listed here carry no evidence. */
export const EVIDENCE_FIELD_NAMES = {
  amount_due_cents: "amountDueCents",
  previous_amount_cents: "previousAmountCents",
  due_date: "dueDate",
  renewal_date: "renewalDate",
  cancel_by_date: "cancelByDate",
  decision_by_date: "decisionByDate",
  frequency: "frequency",
  auto_renews: "autoRenews",
} as const satisfies Record<string, keyof ExtractedFields>;

export interface MappedExtraction {
  /** Every key of `ExtractedFields`, as the review row must have them. */
  fields: ExtractedFields;
  /** Quotes with the contract's field names, at most 140 characters each. Unknown fields are left out. */
  evidence: EvidenceQuote[];
  /**
   * Amounts, dates and the category the contract refused (negative or enormous cents, a date that is not a real day,
   * a category outside the list). A non-empty list means the extraction cannot be trusted as it stands: the pipeline
   * treats it as a failed validation, so it is reviewed by a person and never auto-applied.
   */
  dropped: string[];
}

const nullIfEmpty = (v: string | null): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

export function mapExtraction(e: ExtractionResult): MappedExtraction {
  const dropped: string[] = [];
  const shape = ExtractedFields.shape;

  /** Keeps a value the contract accepts for its field, otherwise null (and remembers a hard drop). */
  const keep = <K extends keyof ExtractedFields>(
    key: K,
    value: ExtractedFields[K],
    hard: boolean,
  ): ExtractedFields[K] | null => {
    if (value === null) return null;
    if (shape[key].safeParse(value).success) return value;
    if (hard) dropped.push(key);
    return null;
  };

  const fields: ExtractedFields = {
    docType: e.doc_type,
    providerName: keep("providerName", nullIfEmpty(e.provider_name)?.slice(0, 120) ?? null, false),
    category: keep("category", e.category, true),
    insuranceType: keep("insuranceType", e.insurance_type, false),
    amountDueCents: keep("amountDueCents", e.amount_due_cents, true),
    previousAmountCents: keep("previousAmountCents", e.previous_amount_cents, true),
    dueDate: keep("dueDate", e.due_date, true),
    renewalDate: keep("renewalDate", e.renewal_date, true),
    cancelByDate: keep("cancelByDate", e.cancel_by_date, true),
    decisionByDate: keep("decisionByDate", e.decision_by_date, true),
    frequency: keep("frequency", e.frequency, false),
    autoRenews: e.auto_renews,
    // Last 4 only (hard rule 7). A value the contract's pattern refuses is dropped; matching just has less to go on.
    accountLast4: keep("accountLast4", e.account_last4, false),
    providerDomain: null,
  };

  const evidence: EvidenceQuote[] = [];
  for (const item of e.evidence) {
    const field = (EVIDENCE_FIELD_NAMES as Record<string, string | undefined>)[item.field];
    if (field === undefined) continue;
    const quote = item.quote.trim();
    if (quote.length === 0 || quote.length > MAX_EVIDENCE_QUOTE_CHARS) continue;
    const parsed = EvidenceQuote.safeParse({ field, quote });
    if (parsed.success) evidence.push(parsed.data);
  }
  return { fields, evidence, dropped };
}
