// email.decide (BACKEND_PLAN §7.8.2 "Auto-apply policy"). Pure: no I/O, no clock, no imports from adapters, so
// the email pipeline (WP-22) can call it with the signals it already has and tests can cover every row.
//
// The caller maps its signals like this:
//   outcome            the WP-11 `ExtractOutcome` (status, and for "ok" `validation.ok` / `validation.advisoryFields`)
//   authentication     the WP-19 `AuthenticationVerdicts` (`dmarcAligned`; missing headers are `UNKNOWN_AUTH`)
//   injectionSuspected the WP-22 pipeline verdict (WP-11 `signals.fenceTampered` plus its own checks)
//   domainMatch        `isDomainMatch(matchResult)` from @mp/email (a unique match through the provider domain)
//   matchedItemConfirmed `matchResult.confirmed`
//   senderFirstSeen    `hasPriorDecidedFromSender(...) === false` (see repo.ts)
//   item               the matched item as the engine sees it: its fixed amount or engine estimate, and the next
//                      expected date (occurrence due date, or the renewal date for renewal notices)
//
// Everything that is not a clear, safe update goes to review. A review is never an error: it only means a
// person looks first. What auto-apply may then WRITE is limited to a strict subset (see `planAutoApply`):
// the actual amount on the matching occurrence, or nothing at all.
//
// This package is pure (no I/O, no clock, no randomness) and imports only types from @mp/contracts.
import type { ExtractedFields } from "@mp/contracts";

/** Replace-an-estimate rule: the actual amount may differ from the estimate by at most this much (§7.8.2). */
export const AUTO_APPLY_TOLERANCE_PERCENT = 50;

export type ReviewReason =
  | "validation_failed" //          a deterministic rule check failed (WP-11 validation.ok = false)
  | "model_refused" //              the model refused the request
  | "invalid_output" //             the output was not valid against the schema
  | "advisory_fields" //            frequency / auto_renews without a supporting quote
  | "sender_not_authenticated" //   no DMARC pass aligned with the From domain (Q-062)
  | "injection_suspected" //        the message was flagged (Q-060)
  | "no_domain_match" //            the item was not matched through the provider domain
  | "item_not_confirmed" //         the matched item is not a confirmed one
  | "first_seen_sender" //          first message from this sender for this item
  | "auto_apply_disabled" //        the household turned automatic updates off
  | "no_matched_item" //            there is nothing to update
  | "doc_type_not_auto" //          only bills, statements and renewal notices can auto-apply
  | "renewal_fields_change" //      the notice would change renewal dates, auto-renew or previous amount (M2)
  | "not_an_expected_change"; //    neither "estimate replaced by an actual" nor "identical to what we expect"

export type AutoApplyChange = "estimate_to_actual" | "identical_notice";

/** The renewal details the item already has. A notice that repeats them changes nothing. */
export interface ExpectedRenewal {
  renewalDate: string | null;
  cancelByDate: string | null;
  decisionByDate: string | null;
  previousAmountCents: number | null;
  autoRenews: boolean | null;
}

/** What we already expect for the matched item (numbers from the engine, never from the model). */
export interface ExpectedItem {
  amountType: "fixed" | "estimated" | "statement";
  /** The fixed amount, or the engine's estimate for an estimated item. */
  expectedAmountCents: number | null;
  /** The next expected due date, or the renewal date for a renewal notice (YYYY-MM-DD). */
  expectedDate: string | null;
  /** The item's current renewal details, null when it has none. */
  renewal: ExpectedRenewal | null;
}

export type DecideOutcome =
  | {
      readonly status: "ok";
      readonly validation: { readonly ok: boolean; readonly advisoryFields: readonly string[] };
    }
  | { readonly status: "refusal" }
  | { readonly status: "invalid_output" };

export interface DecideInput {
  outcome: DecideOutcome;
  authentication: { readonly dmarcAligned: boolean };
  injectionSuspected: boolean;
  domainMatch: boolean;
  matchedItemConfirmed: boolean;
  senderFirstSeen: boolean;
  /** The household setting "automatic updates" (default on). */
  autoApplyEnabled: boolean;
  /** The validated extraction. Ignored when the outcome is not "ok". */
  fields: ExtractedFields | null;
  item: ExpectedItem | null;
}

export type Decision =
  | { readonly action: "auto_apply"; readonly change: AutoApplyChange }
  | { readonly action: "review"; readonly reasons: readonly ReviewReason[] };

const AUTO_DOC_TYPES: ReadonlySet<ExtractedFields["docType"]> = new Set([
  "bill",
  "statement",
  "renewal_notice",
]);

function classify(fields: ExtractedFields, item: ExpectedItem): AutoApplyChange | null {
  const actual = fields.amountDueCents;
  const expected = item.expectedAmountCents;
  if (actual === null || expected === null) return null;
  // (a) An estimate replaced by the actual statement amount, within ±50% of the estimate.
  if (item.amountType === "estimated") {
    if (expected <= 0) return null;
    // The actual must be for the occurrence we expect (its due date), or it would land on the wrong bill.
    if (fields.dueDate === null || fields.dueDate !== item.expectedDate) return null;
    return Math.abs(actual - expected) * 100 <= expected * AUTO_APPLY_TOLERANCE_PERCENT
      ? "estimate_to_actual"
      : null;
  }
  // (b) A bill or renewal notice whose amount and date are identical to what we expect.
  const date = fields.dueDate ?? fields.renewalDate;
  if (actual === expected && date !== null && date === item.expectedDate) return "identical_notice";
  return null;
}

/** True when the notice carries a renewal value that the item does not already have. */
function changesRenewal(f: ExtractedFields, current: ExpectedRenewal | null): boolean {
  const differs = <T>(value: T | null, existing: T | null | undefined) =>
    value !== null && value !== (existing ?? null);
  return (
    differs(f.renewalDate, current?.renewalDate) ||
    differs(f.cancelByDate, current?.cancelByDate) ||
    differs(f.decisionByDate, current?.decisionByDate) ||
    differs(f.previousAmountCents, current?.previousAmountCents) ||
    differs(f.autoRenews, current?.autoRenews)
  );
}

export function decideExtraction(input: DecideInput): Decision {
  const reasons: ReviewReason[] = [];
  const { outcome } = input;

  if (outcome.status === "refusal") reasons.push("model_refused");
  else if (outcome.status === "invalid_output") reasons.push("invalid_output");
  else {
    if (!outcome.validation.ok) reasons.push("validation_failed");
    if (outcome.validation.advisoryFields.length > 0) reasons.push("advisory_fields");
  }
  if (!input.authentication.dmarcAligned) reasons.push("sender_not_authenticated");
  if (input.injectionSuspected) reasons.push("injection_suspected");
  if (!input.domainMatch) reasons.push("no_domain_match");
  if (!input.matchedItemConfirmed) reasons.push("item_not_confirmed");
  if (input.senderFirstSeen) reasons.push("first_seen_sender");
  if (!input.autoApplyEnabled) reasons.push("auto_apply_disabled");

  let change: AutoApplyChange | null = null;
  if (input.item === null) reasons.push("no_matched_item");
  if (outcome.status === "ok") {
    if (input.fields === null) {
      // An "ok" outcome always carries the extraction; without it there is nothing to apply.
      reasons.push("invalid_output");
    } else if (!AUTO_DOC_TYPES.has(input.fields.docType)) {
      reasons.push("doc_type_not_auto");
    } else if (input.item !== null) {
      if (changesRenewal(input.fields, input.item.renewal)) reasons.push("renewal_fields_change");
      change = classify(input.fields, input.item);
      if (change === null) reasons.push("not_an_expected_change");
    }
  }

  // Every path to a null `change` has pushed a reason above (refusal, invalid output, no item, doc type, no
  // expected change), so this fall-through is never reason-less.
  if (reasons.length > 0 || change === null) return { action: "review", reasons };
  return { action: "auto_apply", change };
}
