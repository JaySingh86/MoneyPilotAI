// From a detected candidate to what the review queue stores, and matching candidates to items we already track.
// Pure. The worker validates the result with the `ExtractedFields` contract before it writes anything.
import type { Cadence, RecurringCandidate } from "./recurring";
import { normalizeMerchant } from "./merchant";

/** Mirrors `ExtractedFields` in @mp/contracts: EVERY key is present, null when unknown (WP-14). */
export interface CandidateFields {
  docType: "receipt" | "bill";
  providerName: string;
  category: "income" | "insurance" | "housing" | "childcare" | null;
  insuranceType: null;
  amountDueCents: number | null;
  previousAmountCents: null;
  dueDate: string;
  renewalDate: null;
  cancelByDate: null;
  decisionByDate: null;
  frequency: "monthly" | "every_2_months" | "quarterly" | "every_6_months" | "yearly" | null;
  autoRenews: null;
  accountLast4: null;
  /** Always null: only a person's edit sets it (WP-14). */
  providerDomain: null;
}

const FREQUENCY: Readonly<Record<Cadence, CandidateFields["frequency"]>> = {
  // The review contract has no weekly / biweekly value (Q-140): those candidates carry their cadence in `checks`.
  weekly: null,
  biweekly: null,
  monthly: "monthly",
  every_2_months: "every_2_months",
  quarterly: "quarterly",
  every_6_months: "every_6_months",
  yearly: "yearly",
};

function categoryFor(c: RecurringCandidate): CandidateFields["category"] {
  if (c.direction === "inflow") return "income";
  if (/\b(ins|insurance|assurance)\b/.test(c.merchantNorm)) return "insurance";
  if (/\b(rent|mortgage|apartments|realty)\b/.test(c.merchantNorm)) return "housing";
  if (/\b(daycare|childcare|preschool)\b/.test(c.merchantNorm)) return "childcare";
  return null;
}

/**
 * A fixed amount is a "receipt" (the review service turns a bill or statement with an amount into a
 * statement-type item, Q-141); an estimated amount is left empty so the item is created as an estimate and the
 * engine works its own figure out from history.
 */
export function candidateFields(c: RecurringCandidate): CandidateFields {
  return {
    docType: c.amountType === "fixed" ? "receipt" : "bill",
    providerName: c.displayName,
    category: categoryFor(c),
    insuranceType: null,
    amountDueCents: c.amountType === "fixed" ? c.amountCents : null,
    previousAmountCents: null,
    dueDate: c.nextExpected,
    renewalDate: null,
    cancelByDate: null,
    decisionByDate: null,
    frequency: FREQUENCY[c.cadence],
    autoRenews: null,
    accountLast4: null,
    providerDomain: null,
  };
}

/** The part of an existing item that matching needs. */
export interface ExistingItemRef {
  id: string;
  name: string;
  providerName: string | null;
  direction: "inflow" | "outflow";
  amountType: "fixed" | "estimated" | "statement";
  amountCents: number | null;
}

export interface ItemMatch {
  itemId: string;
  /** `duplicate`: same merchant, same fixed amount. `update`: same merchant, the amount differs or is not fixed. */
  type: "update" | "duplicate";
}

const tokens = (s: string): Set<string> =>
  new Set(
    normalizeMerchant(s)
      .split(" ")
      .filter((w) => w.length > 1),
  );

/** Token overlap of the two names: all of the smaller set inside the larger, and at least one real word. */
function sameMerchant(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((t) => large.has(t));
}

/** Matches by merchant name only (a CSV has no provider domain or account number). A tie matches nothing. */
export function matchExistingItem(
  c: RecurringCandidate,
  items: readonly ExistingItemRef[],
): ItemMatch | null {
  const mine = tokens(c.merchantNorm);
  const hits = items.filter(
    (i) =>
      i.direction === c.direction &&
      (sameMerchant(mine, tokens(i.name)) ||
        (i.providerName !== null && sameMerchant(mine, tokens(i.providerName)))),
  );
  const [hit] = hits;
  if (hits.length !== 1 || !hit) return null;
  const same = hit.amountType === "fixed" && c.amountType === "fixed" && hit.amountCents === c.amountCents;
  return { itemId: hit.id, type: same ? "duplicate" : "update" };
}
