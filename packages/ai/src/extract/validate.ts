import { Temporal } from "@js-temporal/polyfill";
import {
  AMOUNT_FIELDS,
  DATE_FIELDS,
  EVIDENCE_FIELDS,
  MAX_QUOTE_CHARS,
  OPTIONAL_EVIDENCE_FIELDS,
} from "../schemas/extraction.v1";
import type { EvidenceField, ExtractionResult } from "../schemas/extraction.v1";

// BACKEND_PLAN §7.8.2 validation rules. Deterministic, no I/O. A failure never auto-applies: the item goes to
// review. Failure details name the rule and the field only, never a value (CLAUDE.md rule 8).

export type ValidationRule =
  | "evidence_missing" //          rule 1: a non-null amount/date has no quote
  | "evidence_not_verbatim" //     rule 1: the quote is not in the redacted source text
  | "evidence_too_long" //         rule 1: the quote is over 140 characters
  | "evidence_unknown_field" //    rule 1: evidence names a field that is not an amount or date field
  | "amount_mismatch" //           rule 2
  | "date_mismatch" //             rule 2
  | "date_implausible" //          rule 3
  | "amount_implausible" //        rule 4
  | "provider_name_invalid" //     M3: over 80 chars, empty, a URL or a control character
  | "provider_name_not_in_source" // M3: the name is not in the email text
  | "account_last4_invalid" //     M3: not 1-4 of [0-9A-Za-z-]
  | "account_last4_not_in_source" // M3
  | "account_last4_too_long" //    rule 5
  | "truncated" //                 rule 6
  | "irrelevant_has_values"; //    extra: an `irrelevant` result must carry no extracted values

export interface ValidationFailure {
  readonly rule: ValidationRule;
  readonly field: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly failures: readonly ValidationFailure[];
  /**
   * Non-null `frequency` / `auto_renews` with no supporting quote. Not a failure, but the policy engine must
   * not auto-apply on these fields alone.
   */
  readonly advisoryFields: readonly string[];
}

export interface ValidationContext {
  /** The redacted text that was sent to the model. Quotes must be found in it. */
  readonly sourceText: string;
  /** Household-local date the email was received (Temporal PlainDate; never `new Date()`). */
  readonly receivedAt: Temporal.PlainDate;
  /** True when the 20k-character cap cut the email (rule 6). */
  readonly truncated: boolean;
}

/** Allowed window for extracted dates relative to `receivedAt` (rule 3). */
export const DATE_WINDOW_DAYS = { before: 30, after: 400 } as const;

/**
 * PLACEHOLDER ceilings for `amount_due_cents` per category (rule 4: "configured ranges"). The owner confirms
 * the real ranges before G3 (Q-070). `subscription` is the spec's own example (< $500/month).
 */
export const MAX_AMOUNT_CENTS: Readonly<Record<string, number>> = {
  housing: 2_000_000,
  utilities: 100_000,
  childcare: 600_000,
  transport: 500_000,
  debt: 2_000_000,
  subscription: 50_000,
  insurance: 1_000_000,
  membership: 200_000,
  vehicle_home: 2_000_000,
  income: 5_000_000,
  other: 2_000_000,
};
const DEFAULT_MAX_AMOUNT_CENTS = 2_000_000;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Collapses runs of whitespace so line wraps in the email do not break a verbatim match. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const AMOUNT_KEYWORD = "(?:amount due|amount|total|balance|premium|payment)";

/**
 * Every dollar amount a quote states, as integer cents. Only two forms count (M2): a `$`-prefixed amount, or a
 * bare `n.nn` directly after an amount keyword. Reference numbers, versions and dotted dates never match.
 */
export function parseAmountsCents(quote: string): number[] {
  const out: number[] = [];
  const dollar = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d|[.,]\d)/g;
  const keyword = new RegExp(
    `\\b${AMOUNT_KEYWORD}\\b[^\\d$\\n]{0,20}?(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+|\\d+)\\.(\\d{2})(?!\\d|[.,]\\d)`,
    "gi",
  );
  for (const m of quote.matchAll(dollar)) {
    out.push(Number((m[1] ?? "").replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0")));
  }
  for (const m of quote.matchAll(keyword)) {
    out.push(Number((m[1] ?? "").replace(/,/g, "")) * 100 + Number(m[2]));
  }
  return out;
}

interface PartialDate {
  readonly year: number | null;
  readonly month: number;
  readonly day: number;
}

/** Every date a quote states. US numeric, ISO and month-name forms; the year may be missing. */
export function parseDates(quote: string): PartialDate[] {
  const out: PartialDate[] = [];
  const push = (year: number | null, month: number, day: number): void => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    if (year !== null) {
      try {
        Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
      } catch {
        return;
      }
    }
    out.push({ year, month, day });
  };
  const fullYear = (raw: string): number => (raw.length === 2 ? 2000 + Number(raw) : Number(raw));

  for (const m of quote.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of quote.matchAll(
    /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])(?!\s*(?:off\b|%))/gi,
  )) {
    push(m[3] ? fullYear(m[3]) : null, Number(m[1]), Number(m[2]));
  }
  const monthDay = new RegExp(
    `\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4})(?!\\d))?`,
    "gi",
  );
  for (const m of quote.matchAll(monthDay)) {
    if (m[1] === "may") continue; // lowercase "may" is the verb, not the month
    push(m[3] ? Number(m[3]) : null, MONTHS[(m[1] ?? "").toLowerCase()] ?? 0, Number(m[2]));
  }
  const dayMonth = new RegExp(
    `(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4})(?!\\d))?`,
    "gi",
  );
  for (const m of quote.matchAll(dayMonth)) {
    if (m[2] === "may") continue;
    push(m[3] ? Number(m[3]) : null, MONTHS[(m[2] ?? "").toLowerCase()] ?? 0, Number(m[1]));
  }
  return out;
}

/** The first date with this month and day on or after `received` (Feb 29 skips to the next leap year). */
export function nearestUpcoming(
  received: Temporal.PlainDate,
  month: number,
  day: number,
): Temporal.PlainDate | null {
  for (let year = received.year; year <= received.year + 8; year++) {
    try {
      const candidate = Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
      if (Temporal.PlainDate.compare(candidate, received) >= 0) return candidate;
    } catch {
      // not a real date in this year (Feb 29); try the next one
    }
  }
  return null;
}

function dateMatches(
  field: Temporal.PlainDate,
  stated: readonly PartialDate[],
  receivedAt: Temporal.PlainDate,
): boolean {
  return stated.some((s) => {
    if (s.month !== field.month || s.day !== field.day) return false;
    // M1: a date written without a year means the single nearest upcoming date, nothing else.
    if (s.year === null) return nearestUpcoming(receivedAt, s.month, s.day)?.equals(field) ?? false;
    return s.year === field.year;
  });
}

const PROVIDER_NAME_MAX_CHARS = 80;
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const URL_LIKE =
  /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bhttps?:|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|info|biz|app|xyz|example)\b)/i;

function isPlainProviderName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    name.length <= PROVIDER_NAME_MAX_CHARS &&
    !CONTROL_CHARS.test(name) &&
    !URL_LIKE.test(name)
  );
}

function parseIsoDate(value: string): Temporal.PlainDate | null {
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    return null;
  }
}

export function validateExtraction(
  extraction: ExtractionResult,
  context: ValidationContext,
): ValidationResult {
  const failures: ValidationFailure[] = [];
  const fail = (rule: ValidationRule, field: string): void => {
    failures.push({ rule, field });
  };
  const source = normalizeWhitespace(context.sourceText);

  // Rule 6
  if (context.truncated) fail("truncated", "source");

  // Rule 1 (quotes themselves)
  for (const entry of extraction.evidence) {
    if (
      !(EVIDENCE_FIELDS as readonly string[]).includes(entry.field) &&
      !(OPTIONAL_EVIDENCE_FIELDS as readonly string[]).includes(entry.field)
    )
      fail("evidence_unknown_field", entry.field);
    if (entry.quote.length > MAX_QUOTE_CHARS) fail("evidence_too_long", entry.field);
    const quote = normalizeWhitespace(entry.quote);
    if (quote.length === 0 || !source.includes(quote)) fail("evidence_not_verbatim", entry.field);
  }

  const quotesFor = (field: EvidenceField): string[] =>
    extraction.evidence
      .filter((e) => e.field === field)
      .map((e) => normalizeWhitespace(e.quote))
      .filter((q) => source.includes(q));

  // Rules 1 and 2 for amounts
  for (const field of AMOUNT_FIELDS) {
    const value = extraction[field];
    if (value === null) continue;
    const quotes = quotesFor(field);
    if (!extraction.evidence.some((e) => e.field === field)) {
      fail("evidence_missing", field);
    } else if (!quotes.some((q) => parseAmountsCents(q).includes(value))) {
      fail("amount_mismatch", field);
    }
  }

  // Rules 1, 2 and 3 for dates
  for (const field of DATE_FIELDS) {
    const value = extraction[field];
    if (value === null) continue;
    const date = parseIsoDate(value);
    if (!date) {
      fail("date_mismatch", field);
      continue;
    }
    if (!extraction.evidence.some((e) => e.field === field)) {
      fail("evidence_missing", field);
    } else if (!quotesFor(field).some((q) => dateMatches(date, parseDates(q), context.receivedAt))) {
      fail("date_mismatch", field);
    }
    const offset = context.receivedAt.until(date, { largestUnit: "days" }).days;
    if (offset < -DATE_WINDOW_DAYS.before || offset > DATE_WINDOW_DAYS.after) fail("date_implausible", field);
  }

  // Rule 4
  const max =
    (extraction.category ? MAX_AMOUNT_CENTS[extraction.category] : undefined) ?? DEFAULT_MAX_AMOUNT_CENTS;
  for (const field of AMOUNT_FIELDS) {
    const value = extraction[field];
    if (value !== null && (value < 0 || value > max)) fail("amount_implausible", field);
  }

  // Rule 5 and M3: account_last4
  const last4 = extraction.account_last4;
  if (last4 !== null) {
    if (last4.length > 4) fail("account_last4_too_long", "account_last4");
    else if (!/^[0-9A-Za-z-]{1,4}$/.test(last4)) fail("account_last4_invalid", "account_last4");
    else if (!source.includes(last4)) fail("account_last4_not_in_source", "account_last4");
  }

  // M3: provider_name is free text that ends up on screen, so it must be short, plain and in the email.
  const provider = extraction.provider_name;
  if (provider !== null) {
    if (!isPlainProviderName(provider)) fail("provider_name_invalid", "provider_name");
    else if (!source.toLowerCase().includes(normalizeWhitespace(provider).toLowerCase())) {
      fail("provider_name_not_in_source", "provider_name");
    }
  }

  // An `irrelevant` email must not carry any extracted value.
  if (extraction.doc_type === "irrelevant") {
    const carries =
      [...AMOUNT_FIELDS, ...DATE_FIELDS].some((f) => extraction[f] !== null) ||
      extraction.evidence.length > 0;
    if (carries) fail("irrelevant_has_values", "doc_type");
  }

  const advisoryFields = OPTIONAL_EVIDENCE_FIELDS.filter(
    (f) => extraction[f] !== null && !extraction.evidence.some((e) => e.field === f),
  );
  return { ok: failures.length === 0, failures, advisoryFields };
}
