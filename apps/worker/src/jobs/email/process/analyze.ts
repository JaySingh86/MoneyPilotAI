// The pure middle of the pipeline (BACKEND_PLAN §7.8.2): from a model outcome and what the worker knows about the
// household to "what should happen to this message". No I/O, no clock, no model: every amount and date that reaches a
// user was copied from a validated extraction or came from the engine (hard rule 4).
//
//   triage     usable? irrelevant? what did the extraction really say
//   runMatch   which existing item does it belong to (`@mp/email` matcher, by domain first, never by name alone to auto-apply)
//   evaluate   the auto-apply policy (`@mp/review-rules` decideExtraction), the match type and the stored checks
//
// The signals the policy needs are mapped here, once, with the rules the owner set:
//   domainMatch        only `isDomainMatch(match)`
//   authentication     DMARC pass aligned with From (Q-062); a forwarded message never counts, its verdict is the
//                      forwarder's, not the original sender's
//   injectionSuspected the message fence was tampered with (WP-11) or the text sanitizer flagged it (WP-19)
//   senderFirstSeen    supplied by the caller, true when it could not be established
import type { ExtractOutcome } from "@mp/ai/extract";
import type { ExtractedFields, RenewalDetails } from "@mp/contracts";
import { isPriceUp, type Cents } from "@mp/engine";
import {
  isDomainMatch,
  kindOf,
  matchItem,
  type AuthenticationVerdicts,
  type MatchableItem,
  type MatchResult,
} from "@mp/email";
import {
  decideExtraction,
  planUpdate,
  snapshotMatches,
  type Decision,
  type ExpectedItem,
} from "@mp/review-rules";
import { mapExtraction, type MappedExtraction } from "./map";

/** What the pipeline keeps of a prepared email once its text is gone: no body, only signals. */
export interface PreparedSummary {
  senderDomain: string | null;
  /** Already redacted by `prepareEmail`; redacted again before it is stored (see message-meta.ts). */
  subject: string;
  truncated: boolean;
  authentication: AuthenticationVerdicts;
  notes: readonly string[];
  originalSenderDomain: string | null;
  originalSenderSource: "forward_block" | "header" | null;
}

export interface MessageFacts {
  /** The domain recorded at discovery (`email_messages.from_domain`). */
  fromDomain: string;
}

// ===== Triage =====
export interface EffectiveValidation {
  ok: boolean;
  advisoryFields: readonly string[];
  /** Rule and field names only, never a value (hard rule 8). */
  failures: readonly { rule: string; field: string }[];
}

export type Triage =
  | { kind: "unusable"; reason: "refusal" | "invalid_output" | "batch_error" }
  | { kind: "irrelevant" }
  | {
      kind: "extracted";
      mapped: MappedExtraction;
      validation: EffectiveValidation;
      injectionSuspected: boolean;
      fenceTampered: boolean;
    };

export function triage(
  outcome: ExtractOutcome | { status: "batch_error" },
  prepared: Pick<PreparedSummary, "notes">,
): Triage {
  if (outcome.status === "refusal") return { kind: "unusable", reason: "refusal" };
  if (outcome.status === "invalid_output") return { kind: "unusable", reason: "invalid_output" };
  if (outcome.status === "batch_error") return { kind: "unusable", reason: "batch_error" };
  if (outcome.extraction.doc_type === "irrelevant") return { kind: "irrelevant" };

  const mapped = mapExtraction(outcome.extraction);
  const failures = [
    ...outcome.validation.failures.map((f) => ({ rule: f.rule, field: f.field })),
    // A value the review contract cannot hold is a failed check: reviewed by a person, never auto-applied.
    ...mapped.dropped.map((field) => ({ rule: "contract_refused", field })),
  ];
  return {
    kind: "extracted",
    mapped,
    validation: {
      ok: outcome.validation.ok && mapped.dropped.length === 0,
      advisoryFields: outcome.validation.advisoryFields,
      failures,
    },
    fenceTampered: outcome.signals.fenceTampered || prepared.notes.includes("fence_tampered"),
    // `prepareEmail` defuses `<email>` markers before the model sees the text, so the WP-11 fence check cannot see the
    // attempt any more; it leaves the `fence_tampered` note instead (S2).
    injectionSuspected:
      outcome.signals.fenceTampered ||
      prepared.notes.includes("fence_tampered") ||
      prepared.notes.includes("injection_suspected"),
  };
}

// ===== Match =====
export function runMatch(
  items: readonly MatchableItem[],
  fields: ExtractedFields,
  prepared: Pick<PreparedSummary, "senderDomain" | "originalSenderDomain">,
  message: MessageFacts,
): MatchResult {
  return matchItem(
    {
      // A forwarded message names the real sender only inside its block; that finds the item, but it never
      // authorises anything (see `evaluate`).
      senderDomain: prepared.originalSenderDomain ?? prepared.senderDomain ?? message.fromDomain,
      providerName: fields.providerName,
      accountLast4: fields.accountLast4,
      kind: kindOf(fields.category, fields.insuranceType),
    },
    items,
  );
}

/** The matched item as the policy and the apply step need it. Numbers here come from the engine or the database. */
export interface ItemContext {
  id: string;
  name: string;
  category: string;
  rrule: string;
  amountType: "fixed" | "estimated" | "statement";
  /** The stored fixed or statement amount (null for an estimated item). */
  amountCents: Cents | null;
  /** What the engine plans for the item: the fixed amount, the mean of the last 3, or the last statement. */
  expectedAmountCents: Cents | null;
  ownerType: "member" | "both" | "split";
  ownerUserId: string | null;
  /** Upcoming (`scheduled`) bills, earliest first. */
  scheduled: readonly { id: string; scheduledOn: string; dueOn: string; actualAmountCents: Cents | null }[];
  renewal: RenewalDetails | null;
}

const AUTO_RENEWS: Record<RenewalDetails["autoRenews"], boolean | null> = {
  yes: true,
  no: false,
  rolls_over: null,
};

export function expectedFor(ctx: ItemContext, f: ExtractedFields): ExpectedItem {
  // A bill is judged against the bill due on its own date; a notice with no due date, against the renewal date.
  const expectedDate =
    f.dueDate !== null
      ? (ctx.scheduled.find((o) => o.dueOn === f.dueDate)?.dueOn ?? ctx.scheduled[0]?.dueOn ?? null)
      : (ctx.renewal?.coverageEnd ?? null);
  return {
    amountType: ctx.amountType,
    expectedAmountCents: ctx.expectedAmountCents,
    expectedDate,
    renewal: ctx.renewal
      ? {
          renewalDate: ctx.renewal.coverageEnd,
          cancelByDate: ctx.renewal.cancelBy,
          decisionByDate: ctx.renewal.decisionBy,
          previousAmountCents: ctx.renewal.previousAmountCents,
          autoRenews: AUTO_RENEWS[ctx.renewal.autoRenews],
        }
      : null,
  };
}

// ===== Evaluate =====
export type MatchType = "new" | "update" | "decision" | "duplicate";

/** What confirming this extraction would do to the matched item, by `planUpdate`; `duplicate` when nothing. */
export function matchTypeForMatched(f: ExtractedFields, ctx: ItemContext): MatchType {
  if (f.docType === "enrollment_deadline") return "decision";
  const plan = planUpdate("update", f, {
    amountType: ctx.amountType,
    amountCents: ctx.amountCents,
    renewal: ctx.renewal,
  });
  const currentActual = plan.occurrenceActual
    ? (ctx.scheduled.find((o) => o.dueOn === plan.occurrenceActual?.dueDate)?.actualAmountCents ?? null)
    : null;
  const nothing =
    plan.amountCents === null &&
    (plan.occurrenceActual === null || plan.occurrenceActual.amountCents === currentActual) &&
    (plan.renewal === null ||
      (ctx.renewal !== null && snapshotMatches({ ...plan.renewal }, { ...ctx.renewal })));
  return nothing ? "duplicate" : "update";
}

/**
 * A receipt or payment confirmation with nothing recurring in it (no frequency, no renewal) adds nothing to a plan,
 * whether or not an item exists: it is not queued (a card for every receipt would bury the real ones).
 */
export function isPlainReceipt(f: ExtractedFields): boolean {
  return (
    (f.docType === "receipt" || f.docType === "payment_confirmation") &&
    f.frequency === null &&
    f.renewalDate === null &&
    f.cancelByDate === null &&
    f.decisionByDate === null &&
    f.autoRenews === null
  );
}

export interface EvaluateInput {
  extracted: Extract<Triage, { kind: "extracted" }>;
  prepared: PreparedSummary;
  message: MessageFacts;
  match: MatchResult;
  /** Loaded only for a unique match. */
  item: ItemContext | null;
  /** True when it could not be established (an error counts as first-seen). */
  senderFirstSeen: boolean;
  autoApplyEnabled: boolean;
}

export type Evaluation =
  | { kind: "skip"; reason: "plain_receipt" }
  | {
      kind: "route";
      matchType: MatchType;
      matchItemId: string | null;
      decision: Decision;
      /**
       * May this message cause a one-off reminder (Q-134)? Only a clean, domain-matched, confirmed item from a message
       * that is not forwarded and not flagged: a forged "price change" must not put a reminder on a calendar (S3). It also needs DMARC pass aligned with From.
       */
      reminderAllowed: boolean;
      checks: Record<string, unknown>;
    };

export function evaluate(input: EvaluateInput): Evaluation {
  const { extracted, prepared, match, item } = input;
  const fields = extracted.mapped.fields;
  if (isPlainReceipt(fields)) return { kind: "skip", reason: "plain_receipt" };

  const matched = match.status === "matched" && match.itemId !== null && item !== null;
  const forwarded = prepared.originalSenderSource !== null;
  const domainMatch = isDomainMatch(match);
  const dmarcAligned = !forwarded && prepared.authentication.dmarcAligned;

  const decision = decideExtraction({
    outcome: {
      status: "ok",
      validation: { ok: extracted.validation.ok, advisoryFields: extracted.validation.advisoryFields },
    },
    authentication: { dmarcAligned },
    injectionSuspected: extracted.injectionSuspected,
    domainMatch,
    matchedItemConfirmed: match.confirmed,
    senderFirstSeen: input.senderFirstSeen,
    autoApplyEnabled: input.autoApplyEnabled,
    fields,
    item: matched ? expectedFor(item, fields) : null,
  });

  const matchType: MatchType = matched ? matchTypeForMatched(fields, item) : "new";
  return {
    kind: "route",
    matchType,
    matchItemId: matched ? match.itemId : null,
    decision,
    reminderAllowed:
      matched &&
      domainMatch &&
      match.confirmed &&
      !extracted.injectionSuspected &&
      !forwarded &&
      dmarcAligned,
    checks: {
      pipeline: "email.v1",
      validation: {
        ok: extracted.validation.ok,
        failures: extracted.validation.failures,
        advisoryFields: extracted.validation.advisoryFields,
        truncated: prepared.truncated,
      },
      match: { status: match.status, method: match.method, candidates: match.candidates.length },
      signals: {
        dmarcAligned,
        forwarded,
        injectionSuspected: extracted.injectionSuspected,
        fenceTampered: extracted.fenceTampered,
        domainMatch,
        senderFirstSeen: input.senderFirstSeen,
        autoApplyEnabled: input.autoApplyEnabled,
      },
      decision:
        decision.action === "auto_apply"
          ? { action: "auto_apply", change: decision.change }
          : { action: "review", reasons: decision.reasons },
    },
  };
}

// ===== Price change (Q-134) =====
/**
 * A validated price increase on the matched item. The previous amount is the one the email quotes; for a bare
 * `price_change` notice that only names the new price, it is what the engine plans for the item today. "Up" is the
 * engine's own rule (`isPriceUp`), so the reminder agrees with the price-up flag on screen.
 */
export function isPriceChange(
  extracted: Extract<Triage, { kind: "extracted" }>,
  item: Pick<ItemContext, "expectedAmountCents"> | null,
): boolean {
  if (!extracted.validation.ok) return false;
  const f = extracted.mapped.fields;
  if (f.amountDueCents === null) return false;
  const before =
    f.previousAmountCents ?? (f.docType === "price_change" ? (item?.expectedAmountCents ?? null) : null);
  return before !== null && isPriceUp(before, f.amountDueCents);
}
