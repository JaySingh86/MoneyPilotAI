import { z } from "zod";

// BACKEND_PLAN §7.8.2 extraction schema. Amounts are integer cents; dates are YYYY-MM-DD.
// Constraints the structured-output grammar cannot express (quote length, plausibility) are enforced in
// extract/validate.ts, so the JSON Schema sent to the API stays inside the supported subset.

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

export const CATEGORIES = [
  "housing",
  "utilities",
  "childcare",
  "transport",
  "debt",
  "subscription",
  "insurance",
  "membership",
  "vehicle_home",
  "income",
  "other",
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

export const FREQUENCIES = [
  "monthly",
  "every_2_months",
  "quarterly",
  "every_6_months",
  "yearly",
  "one_time",
] as const;

/** Fields that carry an amount or a date. Each non-null one needs an evidence quote (rule 1). */
export const AMOUNT_FIELDS = ["amount_due_cents", "previous_amount_cents"] as const;
export const DATE_FIELDS = ["due_date", "renewal_date", "cancel_by_date", "decision_by_date"] as const;
export const EVIDENCE_FIELDS = [...AMOUNT_FIELDS, ...DATE_FIELDS] as const;
/** Fields that may carry a quote. Without one they are advisory: they must not drive an auto-apply. */
export const OPTIONAL_EVIDENCE_FIELDS = ["frequency", "auto_renews"] as const;

export const MAX_QUOTE_CHARS = 140;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const extractionSchema = z.strictObject({
  doc_type: z.enum(DOC_TYPES),
  provider_name: z.string().nullable(),
  category: z.enum(CATEGORIES).nullable(),
  insurance_type: z.enum(INSURANCE_TYPES).nullable(),
  amount_due_cents: z.number().int().nullable(),
  previous_amount_cents: z.number().int().nullable(),
  due_date: isoDate.nullable(),
  renewal_date: isoDate.nullable(),
  cancel_by_date: isoDate.nullable(),
  decision_by_date: isoDate.nullable(),
  frequency: z.enum(FREQUENCIES).nullable(),
  auto_renews: z.boolean().nullable(),
  /** Only the last 4 characters of an account or policy number (CLAUDE.md rule 7). */
  account_last4: z.string().nullable(),
  evidence: z.array(z.strictObject({ field: z.string(), quote: z.string() })),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/** Keywords that the structured-output grammar does not accept; removed from the generated schema. */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "multipleOf",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!UNSUPPORTED_KEYWORDS.has(key)) out[key] = sanitize(value);
    }
    return out;
  }
  return node;
}

/** JSON Schema for `output_config.format`. Every object is closed (`additionalProperties: false`). */
export function extractionJsonSchema(): Record<string, unknown> {
  return sanitize(z.toJSONSchema(extractionSchema, { io: "output" })) as Record<string, unknown>;
}
