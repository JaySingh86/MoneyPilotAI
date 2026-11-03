// email.match (BACKEND_PLAN §7.8.2): find the existing item an extraction belongs to.
// Order: provider_domain + account_last4 -> provider_domain + kind -> fuzzy name. Pure; never guesses:
// two equally good candidates give `ambiguous` and no itemId.
import { isFreeMailDomain, isSameOrSubdomain, normalizeDomain } from "./domain.js";

export interface MatchableItem {
  id: string;
  /** Provider name as the household knows it. */
  providerName: string;
  /** Domain the provider mails from, when known. */
  providerDomain: string | null;
  /** Last 4 only, never a full number (hard rule 7). */
  accountLast4: string | null;
  /** `category` or `category:subtype`, see kindOf. */
  kind: string | null;
  confirmed: boolean;
}

export interface MatchQuery {
  /** Domain of the message sender. */
  senderDomain: string | null;
  providerName: string | null;
  accountLast4: string | null;
  kind: string | null;
}

export type MatchMethod = "domain_last4" | "domain_kind" | "fuzzy_name";

export interface MatchResult {
  status: "matched" | "ambiguous" | "none";
  itemId: string | null;
  method: MatchMethod | null;
  /** Candidate ids when ambiguous (or the single match). */
  candidates: string[];
  /** Whether the matched item is a confirmed one. Auto-apply requires true. */
  confirmed: boolean;
  /**
   * True only when the match rests on the provider DOMAIN (domain_last4 or domain_kind). Fuzzy-name matches,
   * ambiguous results and non-matches are false. Auto-apply requires it (BACKEND_PLAN §7.8.2).
   */
  byDomain: boolean;
}

const NONE: MatchResult = {
  status: "none",
  itemId: null,
  method: null,
  candidates: [],
  confirmed: false,
  byDomain: false,
};

/**
 * Guard for WP-22's auto-apply: a unique match made through the provider domain. Derived from `status` and
 * `method`, so a hand-built or fuzzy result cannot pass.
 */
export function isDomainMatch(r: MatchResult): boolean {
  return (
    r.status === "matched" && r.itemId !== null && (r.method === "domain_last4" || r.method === "domain_kind")
  );
}

export const FUZZY_MIN_SCORE = 0.85;
export const FUZZY_MIN_MARGIN = 0.1;

/** `insurance` + `auto` -> `insurance:auto`; the subtype is only used for insurance. */
export function kindOf(category: string | null, insuranceType: string | null): string | null {
  if (!category) return null;
  return category === "insurance" && insuranceType ? `insurance:${insuranceType}` : category;
}

/** Kinds agree when equal, or when one is the bare category of the other (`insurance` ~ `insurance:auto`). */
function kindsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const isBare = (k: string) => !k.includes(":");
  return (isBare(b) && a.split(":")[0] === b) || (isBare(a) && b.split(":")[0] === a);
}

function cleanLast4(v: string | null): string | null {
  return v !== null && /^[A-Za-z0-9]{1,4}$/.test(v) ? v.toLowerCase() : null;
}

const STOP = new Set([
  "inc",
  "llc",
  "co",
  "corp",
  "company",
  "the",
  "of",
  "and",
  "ltd",
  "insurance",
  "group",
]);

function nameTokens(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams of the token-normalised names (0..1). */
export function nameSimilarity(a: string, b: string): number {
  const x = nameTokens(a).join(" ");
  const y = nameTokens(b).join(" ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of bx) {
    total += n;
    overlap += Math.min(n, by.get(g) ?? 0);
  }
  for (const n of by.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

function result(
  status: MatchResult["status"],
  method: MatchMethod,
  ids: string[],
  items: MatchableItem[],
): MatchResult {
  if (status === "matched") {
    const item = items.find((i) => i.id === ids[0])!;
    return {
      status,
      itemId: item.id,
      method,
      candidates: [item.id],
      confirmed: item.confirmed,
      byDomain: method !== "fuzzy_name",
    };
  }
  return { status, itemId: null, method, candidates: ids, confirmed: false, byDomain: false };
}

export function matchItem(query: MatchQuery, items: readonly MatchableItem[]): MatchResult {
  const all = [...items];
  const sender = normalizeDomain(query.senderDomain);
  const last4 = cleanLast4(query.accountLast4);
  const senderUsable = sender !== null && !isFreeMailDomain(sender);

  // Items from the sender's domain whose known last 4 does not contradict the message.
  const domainItems = senderUsable
    ? all.filter(
        (i) =>
          i.providerDomain !== null &&
          isSameOrSubdomain(sender, i.providerDomain) &&
          !(last4 && cleanLast4(i.accountLast4) && cleanLast4(i.accountLast4) !== last4),
      )
    : [];

  // 1. provider_domain + account_last4
  if (last4) {
    const hits = domainItems.filter((i) => cleanLast4(i.accountLast4) === last4);
    if (hits.length === 1) return result("matched", "domain_last4", [hits[0]!.id], all);
    if (hits.length > 1)
      return result(
        "ambiguous",
        "domain_last4",
        hits.map((i) => i.id),
        all,
      );
  }

  // 2. provider_domain + kind
  if (query.kind) {
    const hits = domainItems.filter((i) => i.kind !== null && kindsCompatible(i.kind, query.kind!));
    if (hits.length === 1) return result("matched", "domain_kind", [hits[0]!.id], all);
    if (hits.length > 1)
      return result(
        "ambiguous",
        "domain_kind",
        hits.map((i) => i.id),
        all,
      );
  }

  // 3. fuzzy provider name. Only items we cannot tell apart by domain: an item with a known domain that
  //    differs from the sender is never fuzzy-matched (spoof guard).
  if (query.providerName) {
    const scored = all
      .filter(
        (i) => i.providerDomain === null || (senderUsable && isSameOrSubdomain(sender, i.providerDomain)),
      )
      .filter((i) => !(last4 && cleanLast4(i.accountLast4) && cleanLast4(i.accountLast4) !== last4))
      .filter((i) => !(query.kind && i.kind && !kindsCompatible(i.kind, query.kind)))
      .map((i) => ({ i, s: nameSimilarity(query.providerName!, i.providerName) }))
      .filter((x) => x.s >= FUZZY_MIN_SCORE)
      .sort((a, b) => b.s - a.s);
    if (scored.length === 1) return result("matched", "fuzzy_name", [scored[0]!.i.id], all);
    if (scored.length > 1) {
      if (scored[0]!.s - scored[1]!.s >= FUZZY_MIN_MARGIN)
        return result("matched", "fuzzy_name", [scored[0]!.i.id], all);
      return result(
        "ambiguous",
        "fuzzy_name",
        scored.map((x) => x.i.id),
        all,
      );
    }
  }
  return NONE;
}
