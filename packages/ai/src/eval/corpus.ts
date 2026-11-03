import { z } from "zod";
import { extractionSchema } from "../schemas/extraction.v1";

// Eval corpus format: `{ email_text, expected_fields }` plus the labels the gates need (WP-11).

export const CASE_CATEGORIES = [
  "utility_bill",
  "statement",
  "insurance_renewal",
  "price_change",
  "enrollment",
  "receipt",
  "payment_confirmation",
  "promotion",
  "notification",
  "phishing",
  "injection",
] as const;

/** Every extraction field except `evidence`; fields left out of `expected_fields` are expected to be null. */
const expectedFields = extractionSchema.omit({ evidence: true }).partial();

export const corpusCaseSchema = z.strictObject({
  id: z.string().min(1),
  category: z.enum(CASE_CATEGORIES),
  /** The redacted email text exactly as it would be sent to the model. */
  email_text: z.string().min(1),
  /** Household-local date received, YYYY-MM-DD. */
  received_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  truncated: z.boolean().default(false),
  expected_fields: expectedFields,
  /** Quotes a correct answer would cite; used only to build the synthetic recordings. */
  expected_evidence: z.array(z.strictObject({ field: z.string(), quote: z.string() })).default([]),
  /** The gate for field precision only counts cases that could be auto-applied. */
  auto_apply_candidate: z.boolean().default(false),
  /** Present on injection cases: values an attacker wants and a correct answer never contains. */
  forbidden: z
    .array(z.strictObject({ field: z.string(), value: z.union([z.string(), z.number()]) }))
    .default([]),
});

export const corpusSchema = z.strictObject({
  version: z.literal(1),
  /** Where the cases came from. Shown at the top of the eval report. */
  provenance: z.string(),
  /**
   * True only for generated, non-personal cases. Recordings may be committed only for synthetic corpora;
   * consented real-email corpora stay outside the repo (see packages/ai/README.md).
   */
  synthetic: z.boolean(),
  cases: z.array(corpusCaseSchema).min(1),
});

export type CorpusCase = z.infer<typeof corpusCaseSchema>;
export type Corpus = z.infer<typeof corpusSchema>;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export type ExpectedFieldName = keyof z.infer<typeof expectedFields>;

export const COMPARED_FIELDS = [
  "doc_type",
  "provider_name",
  "category",
  "insurance_type",
  "amount_due_cents",
  "previous_amount_cents",
  "due_date",
  "renewal_date",
  "cancel_by_date",
  "decision_by_date",
  "frequency",
  "auto_renews",
  "account_last4",
] as const satisfies readonly ExpectedFieldName[];

export const GATED_FIELDS = [
  "amount_due_cents",
  "previous_amount_cents",
  "due_date",
  "renewal_date",
  "cancel_by_date",
  "decision_by_date",
] as const satisfies readonly ExpectedFieldName[];

/** Expected value of a field: null when the case does not list it. */
export function expectedValue(
  testCase: CorpusCase,
  field: ExpectedFieldName,
): string | number | boolean | null {
  return testCase.expected_fields[field] ?? null;
}

export function parseCorpus(json: unknown): Corpus {
  return corpusSchema.parse(json);
}
