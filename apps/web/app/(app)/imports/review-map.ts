// Maps the review contracts to what the Email & imports screen shows. Pure functions: every amount
// is formatted by @mp/format from cents the API sent, and every date is a PlainDate string.
import { maskLast4, money } from "@mp/format";
import type { ExtractedField, ReviewTag } from "@mp/ui";
import type {
  AppliedChange,
  ExtractedFields,
  ReviewDecision,
  ReviewItem,
} from "../../../lib/api/imports-types";
import { parseDate, shortDate } from "../../../lib/format/dates";
import { localDate } from "../../../lib/format/input";

const INSURANCE_LABEL: Record<NonNullable<ExtractedFields["insuranceType"]>, string> = {
  auto: "Car",
  motorcycle: "Motorcycle",
  health: "Health",
  dental: "Dental",
  home: "Home",
  renters: "Renters",
  life: "Life",
  pet: "Pet",
  other: "Insurance",
};

const DOC_NOUN: Record<ExtractedFields["docType"], string> = {
  bill: "bill",
  statement: "bill",
  renewal_notice: "renewal",
  price_change: "price change",
  receipt: "receipt",
  enrollment_deadline: "enrollment",
  payment_confirmation: "payment",
  irrelevant: "email",
};

/**
 * The card title (Q-171). The contract has no display title. An `update` card is named after the item it
 * matches plus the document type ("Electricity bill", as on the canvas); `itemName` is looked up with
 * `matchItemId` in the items the web loads. `providerName` titles only a `new` match (and an update whose item
 * could not be found), built from the extracted fields.
 */
export function reviewTitle(item: ReviewItem, itemName: string | null = null): string {
  const f = item.fields;
  if (item.matchType === "update" && itemName) return `${itemName} ${DOC_NOUN[f.docType]}`;
  const provider = f.providerName ?? "Unknown sender";
  const insurance = f.insuranceType ? INSURANCE_LABEL[f.insuranceType] : null;
  switch (f.docType) {
    case "enrollment_deadline":
      return insurance === "Health" ? "Health plan open enrollment" : `${provider} enrollment`;
    case "renewal_notice":
      if (insurance) return `${insurance}${insurance === "Insurance" ? "" : " insurance"} renewal`;
      return f.autoRenews ? `${provider} auto-renewal` : `${provider} renewal`;
    case "price_change":
      return `${provider} price change`;
    case "bill":
    case "statement":
      return `${provider} bill`;
    default:
      return provider;
  }
}

export function reviewTag(item: ReviewItem): ReviewTag {
  if (item.matchType === "decision") return { variant: "attention", label: "Needs a decision" };
  if (item.matchType === "new") return { variant: "ok", label: "New renewal" };
  return { variant: "info", label: "Updates existing" };
}

const PER: Record<NonNullable<ExtractedFields["frequency"]>, string> = {
  monthly: "month",
  every_2_months: "2 months",
  quarterly: "quarter",
  every_6_months: "6 months",
  yearly: "year",
  one_time: "payment",
};

function perPeriod(cents: number, frequency: ExtractedFields["frequency"]): string {
  const text = money(cents, { mode: "detail" });
  return frequency && frequency !== "one_time" ? `${text} / ${PER[frequency]}` : text;
}

/** The extracted-fields grid (§4 review queue item): only what the email actually said. */
export function reviewFields(f: ExtractedFields): ExtractedField[] {
  const out: ExtractedField[] = [];
  const renewal = f.docType === "renewal_notice";
  if (f.amountDueCents !== null) {
    if (f.docType === "enrollment_deadline") {
      out.push({ label: "Current premium", value: { text: perPeriod(f.amountDueCents, f.frequency) } });
    } else if (renewal) {
      out.push({
        label: f.insuranceType ? "Premium" : "Price",
        value: { text: perPeriod(f.amountDueCents, f.frequency) },
      });
    } else {
      out.push({ label: "Amount due", value: { cents: f.amountDueCents } });
    }
  }
  if (f.renewalDate) out.push({ label: "Renews", value: { date: parseDate(f.renewalDate) } });
  if (f.dueDate) out.push({ label: "Due", value: { date: parseDate(f.dueDate) } });
  if (f.decisionByDate) out.push({ label: "Deadline", value: { date: parseDate(f.decisionByDate) } });
  if (f.cancelByDate) out.push({ label: "Cancel by", value: { date: parseDate(f.cancelByDate) } });
  if (f.previousAmountCents !== null) {
    out.push({ label: "Last year", value: { cents: f.previousAmountCents } });
  }
  if (f.autoRenews !== null) out.push({ label: "Auto-renew", value: { text: f.autoRenews ? "On" : "Off" } });
  if (f.accountLast4) out.push({ label: "Account", value: { text: maskLast4(f.accountLast4) } });
  return out;
}

/** Safe to spend, floored to whole dollars (§7: money you can spend rounds down). */
function safe(cents: number): string {
  return money(cents, { mode: "headline", rounding: "floor" });
}

/**
 * The effect sentence under the fields: the API's own text, which has no amounts. `planDelta.safeToSpendCents` is
 * a change and is always null for now (Q-121), so there is no "Safe to spend goes from … to …" sentence; the web
 * never works it out itself (Q-171).
 */
export function effectText(item: ReviewItem): string {
  return item.effect.summary;
}

/** The `role="status"` line after a decision: what changed (golden: "Electricity set to $151.37. Safe to spend is now $997."). */
export function decisionMessage(
  decision: ReviewDecision,
  kind: "confirm" | "edit" | "ignore",
  previousSafeCents: number | null = null,
): string {
  if (kind === "ignore" || !decision.appliedChange) return "Ignored. We won’t suggest this email again.";
  const change = decision.appliedChange;
  const name = change.entityName ?? "Item";
  const amount = typeof change.after.amountCents === "number" ? change.after.amountCents : null;
  let text: string;
  if (decision.item.matchType === "decision") {
    const due = decision.item.fields.decisionByDate;
    text = due ? `Decision task added, due ${shortDate(due, due)}.` : "Decision task added.";
  } else if (decision.item.matchType === "new") {
    text = `${name} added to renewals.`;
  } else if (amount !== null && decision.item.fields.docType !== "renewal_notice") {
    text = `${name} set to ${money(amount, { mode: "detail" })}.`;
  } else {
    text = `${name} updated.`;
  }
  // `decision.plan` is the engine's fresh safe to spend. Say it when it differs from what the page showed (the
  // web compares two engine numbers; it never works out a change itself, Q-171).
  const changed =
    previousSafeCents !== null &&
    decision.plan &&
    safe(decision.plan.safeToSpendCents) !== safe(previousSafeCents);
  if (decision.plan && (changed || kind === "edit")) {
    text += ` Safe to spend is now ${safe(decision.plan.safeToSpendCents)}.`;
  }
  return text;
}

export interface AppliedRow {
  title: string;
  detail: string;
}

/** One "Applied automatically" row from an applied change. */
export function appliedRow(change: AppliedChange, today: string, timeZone: string): AppliedRow {
  const name = change.entityName ?? "Item";
  const after = typeof change.after.amountCents === "number" ? change.after.amountCents : null;
  const before =
    change.before && typeof change.before.amountCents === "number" ? change.before.amountCents : null;
  const due = typeof change.after.dueDate === "string" ? change.after.dueDate : null;
  const when = shortDate(localDate(change.appliedAt, timeZone), today);
  if (after !== null && before !== null && before !== after) {
    return {
      title: `${name}, ${money(before, { mode: "detail" })} → ${money(after, { mode: "detail" })}`,
      detail: `Price change in an email · flagged for review · ${when}`,
    };
  }
  const amountText = after === null ? "" : `, ${money(after, { mode: "detail" })}`;
  const dueText = due ? ` due ${shortDate(due, today)}` : "";
  return {
    title: `${name}${amountText}${dueText}`,
    detail: `Matched something you’d already confirmed · ${when}`,
  };
}

const FREQUENCY_LABEL: Record<NonNullable<ExtractedFields["frequency"]>, string> = {
  monthly: "Monthly",
  every_2_months: "Every 2 months",
  quarterly: "Every 3 months",
  every_6_months: "Every 6 months",
  yearly: "Yearly",
  one_time: "One time",
};

export interface CsvRow {
  id: string;
  name: string;
  /** Null when the file shows a varying amount. */
  amountCents: number | null;
  income: boolean;
  /** "Monthly · next Nov 5", from the extracted fields only. */
  label: string;
}

/** A detection from a bank CSV, as a row of the setup list (a review item with `source = csv`, Q-174). */
export function csvRow(item: ReviewItem, today: string, itemName: string | null = null): CsvRow {
  const f = item.fields;
  const frequency = f.frequency ? FREQUENCY_LABEL[f.frequency] : null;
  const next = f.dueDate ? `next ${shortDate(f.dueDate, today)}` : null;
  return {
    id: item.id,
    name: itemName ?? f.providerName ?? "Unknown",
    amountCents: f.amountDueCents,
    income: f.category === "income",
    label: [frequency, next].filter((p): p is string => p !== null).join(" · ") || "Repeating",
  };
}
