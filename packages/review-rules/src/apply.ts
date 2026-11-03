// Turns a reviewed extraction into changes to items. Pure: the service applies the plan through the WP-06
// items service, so ownership rules, version checks and occurrence rebuilds all stay in one place.
// No number is computed here: amounts and dates are copied from the (validated, possibly edited) fields.
// Types only: this package never imports contracts at run time (dependency-cruiser enforces it).
import type { CreateItem, ExtractedFields, RenewalDetails, Schedule } from "@mp/contracts";
import type { AutoApplyChange } from "./decide";

/** The part of the matched item a plan needs (from the items service's `Item`). */
export interface PlanItem {
  amountType: "fixed" | "estimated" | "statement";
  amountCents: number | null;
  renewal: RenewalDetails | null;
}

export interface UpdatePlan {
  /** New fixed amount or last statement amount for the item; null = leave it. */
  amountCents: number | null;
  /** For an estimated item: the actual amount for the occurrence due on `dueDate`. */
  occurrenceActual: { dueDate: string; amountCents: number } | null;
  /** The full renewal record to write (existing values kept where the notice says nothing); null = leave it. */
  renewal: RenewalDetails | null;
}

const NO_RENEWAL: RenewalDetails = {
  autoRenews: "yes",
  coverageStart: null,
  coverageEnd: null,
  cancelBy: null,
  decisionBy: null,
  shopAroundOn: null,
  previousAmountCents: null,
  priceChangedOn: null,
};

function hasRenewalFields(f: ExtractedFields): boolean {
  return (
    f.renewalDate !== null ||
    f.cancelByDate !== null ||
    f.decisionByDate !== null ||
    f.previousAmountCents !== null ||
    f.autoRenews !== null
  );
}

/** What confirming an `update` or `decision` does to the matched item. A `duplicate` does nothing. */
export function planUpdate(
  matchType: "update" | "decision" | "duplicate" | "new",
  f: ExtractedFields,
  item: PlanItem,
): UpdatePlan {
  if (matchType === "duplicate" || matchType === "new") {
    return { amountCents: null, occurrenceActual: null, renewal: null };
  }
  let amountCents: number | null = null;
  let occurrenceActual: UpdatePlan["occurrenceActual"] = null;
  if (matchType === "update" && f.amountDueCents !== null) {
    if (item.amountType === "estimated") {
      if (f.dueDate !== null) occurrenceActual = { dueDate: f.dueDate, amountCents: f.amountDueCents };
    } else if (f.amountDueCents !== item.amountCents) {
      amountCents = f.amountDueCents;
    }
  }
  let renewal: RenewalDetails | null = null;
  if (hasRenewalFields(f)) {
    const base = item.renewal ?? NO_RENEWAL;
    renewal = {
      ...base,
      autoRenews: f.autoRenews === null ? base.autoRenews : f.autoRenews ? "yes" : "no",
      coverageEnd: f.renewalDate ?? base.coverageEnd,
      cancelBy: f.cancelByDate ?? base.cancelBy,
      decisionBy: f.decisionByDate ?? base.decisionBy,
      previousAmountCents: f.previousAmountCents ?? base.previousAmountCents,
    };
  }
  return { amountCents, occurrenceActual, renewal };
}

export interface AutoApplyPlan {
  /** The only thing auto-apply writes: the actual amount on the occurrence due on `dueDate`. */
  occurrenceActual: { dueDate: string; amountCents: number } | null;
}

/**
 * What an AUTO-applied change may write: a strict subset of `planUpdate`. An estimate replaced by an actual sets
 * the actual on the matching occurrence; an identical notice writes nothing. Renewal fields, the item amount,
 * owner and status are never touched without a person (M2).
 */
export function planAutoApply(change: AutoApplyChange, f: ExtractedFields): AutoApplyPlan {
  if (change === "identical_notice") return { occurrenceActual: null };
  if (f.dueDate === null || f.amountDueCents === null) return { occurrenceActual: null };
  return { occurrenceActual: { dueDate: f.dueDate, amountCents: f.amountDueCents } };
}

export type NewItemResult =
  | { ok: true; item: CreateItem; renewal: Partial<RenewalDetails> | null }
  | { ok: false; field: string; message: string };

const KIND_BY_CATEGORY: Readonly<Record<string, CreateItem["kind"]>> = {
  subscription: "subscription",
  insurance: "insurance",
  membership: "membership",
  debt: "loan",
  income: "income",
};

function scheduleFor(f: ExtractedFields, base: string): Schedule | null {
  switch (f.frequency) {
    case "monthly":
      return { type: "monthly_day", day: Number(base.slice(8, 10)), dtstart: base };
    case "every_2_months":
      return { type: "every_n_months", n: 2, dtstart: base };
    case "quarterly":
      return { type: "every_n_months", n: 3, dtstart: base };
    case "every_6_months":
      return { type: "every_n_months", n: 6, dtstart: base };
    case "yearly":
      return { type: "yearly", dtstart: base };
    case "one_time":
      return { type: "yearly", dtstart: base, until: base };
    default:
      return null;
  }
}

/**
 * The item a confirmed `new` extraction creates, owned by the person who confirmed it. Asks for the missing
 * piece (the user can edit the fields) rather than guessing a name, date or frequency.
 */
export function itemFromFields(f: ExtractedFields, ctx: { ownerUserId: string }): NewItemResult {
  if (f.providerName === null) return { ok: false, field: "providerName", message: "A name is needed." };
  const base = f.dueDate ?? f.renewalDate;
  if (base === null) return { ok: false, field: "dueDate", message: "A due or renewal date is needed." };
  const schedule = scheduleFor(f, base);
  if (schedule === null) return { ok: false, field: "frequency", message: "How often it repeats is needed." };

  const category = f.category ?? "other";
  const amountType =
    f.amountDueCents === null
      ? "estimated"
      : f.docType === "bill" || f.docType === "statement"
        ? "statement"
        : "fixed";
  const item: CreateItem = {
    direction: category === "income" ? "inflow" : "outflow",
    kind: KIND_BY_CATEGORY[category] ?? "bill",
    category,
    name: f.providerName.slice(0, 80),
    providerName: f.providerName,
    // Only a domain a person confirmed in the edit body; the sender's domain is never copied automatically (M3).
    providerDomain: f.providerDomain,
    amountType,
    amountCents: f.amountDueCents,
    schedule,
    weekendRule: "none",
    ownerType: "member",
    ownerUserId: ctx.ownerUserId,
    status: "active",
    accountLast4:
      f.accountLast4 !== null && /^[0-9A-Za-z]{2,4}$/.test(f.accountLast4) ? f.accountLast4 : null,
    paidFrom: "account",
    markedPossiblyUnused: false,
    onBillsPage: true,
  };
  const renewal = hasRenewalFields(f)
    ? {
        autoRenews: f.autoRenews === false ? ("no" as const) : ("yes" as const),
        coverageEnd: f.renewalDate,
        cancelBy: f.cancelByDate,
        decisionBy: f.decisionByDate,
        previousAmountCents: f.previousAmountCents,
      }
    : null;
  return { ok: true, item, renewal };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** True when `current` still holds every value the change wrote (`after`). Undo refuses otherwise. */
export function snapshotMatches(after: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return Object.entries(after).every(([key, value]) => deepEqual(value, current[key]));
}
