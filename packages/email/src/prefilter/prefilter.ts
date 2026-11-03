// email.prefilter (BACKEND_PLAN §7.8.2): decide from METADATA only whether a message is worth fetching.
// Order: ignored domain / promotions / social -> out; watched domain or keyword score >= threshold -> continue;
// anything else -> out. Pure. The message body is never an input.
import { isSameOrSubdomain, normalizeDomain } from "../match/domain.js";

export interface MessageMetadata {
  /** Raw From header value. */
  from: string;
  subject: string;
  /** Provider labels/categories, e.g. Gmail `CATEGORY_PROMOTIONS`. */
  labels?: readonly string[];
  listId?: string | null;
}

export interface PrefilterConfig {
  watchedDomains: readonly string[];
  ignoredDomains: readonly string[];
  threshold?: number;
}

export type PrefilterReason =
  "ignored_domain" | "promotions" | "social" | "watched_domain" | "keyword_score" | "low_score";

export interface PrefilterResult {
  decision: "continue" | "out";
  reason: PrefilterReason;
  score: number;
}

export const DEFAULT_THRESHOLD = 3;

export function parseFromAddress(from: string): { local: string; domain: string } | null {
  const angled = /<([^<>]*)>\s*$/.exec(from);
  const candidate = (angled ? angled[1]! : from).trim();
  const at = candidate.lastIndexOf("@");
  if (at < 1) return null;
  const local = candidate.slice(0, at).trim().toLowerCase();
  const domain = normalizeDomain(candidate.slice(at + 1));
  if (!domain || !/^[a-z0-9._%+-]+$/.test(local)) return null;
  return { local, domain };
}

// Weighted phrases. Each phrase counts once per message (so repetition cannot inflate the score).
const POSITIVE: [RegExp, number][] = [
  [/\bstatements?\b/, 3],
  [/\binvoices?\b/, 3],
  [/\bamount due\b|\bpayment due\b|\bbalance due\b|\bdue (?:in|on|by)\b/, 3],
  [/\b(?:your|new|latest) bill\b|\bbill is ready\b|\bbilling\b/, 3],
  [/\brenew(?:s|al|ing)?\b|\bauto-?renew\b/, 3],
  [/\bpremium\b/, 3],
  [/\bpolicy\b/, 3],
  [/\bopen enrollment\b/, 3],
  [/\bprice (?:change|increase)\b|\brate (?:change|increase|is changing)\b/, 3],
  [/\bpayment (?:received|confirmation|confirmed|scheduled|posted)\b|\bautopay\b/, 3],
  [/\breceipt\b/, 3],
  [/\bsubscription\b|\bmembership\b/, 3],
  [/\b(?:payment|payments|bill)\b/, 2],
  [/\bplan will\b|\byour plan\b/, 1],
];

const NEGATIVE: [RegExp, number][] = [
  [/\d+\s?%\s*off\b|\bsave up to\b|\b\d+%\s+on\b/, 4],
  [/\b(?:sale|deals?|coupons?|giveaway|discount|clearance)\b/, 4],
  [/\b(?:newsletter|webinar|digest)\b/, 4],
  [/\b(?:exclusive|limited time|last chance|don'?t miss|introducing|you'?re invited|free shipping)\b/, 4],
  [/\b(?:order has shipped|your cart|new arrivals|happy birthday|rate your)\b/, 4],
  [/\bprivacy policy\b|\bterms of service\b/, 4],
  [/\b(?:security alert|verify your email|new sign-?in)\b/, 4],
];

const SENDER_POSITIVE = /^(?:billing|statements?|invoices?|payments?|accounts?|renewals?|receipts?|autopay)$/;
const SENDER_NEGATIVE = /^(?:marketing|promo|offers?|deals?|newsletter|news)$/;

function scoreSubject(subject: string): number {
  const s = subject
    .normalize("NFKC")
    .slice(0, 500)
    .toLowerCase()
    .replace(/^(?:\s*(?:re|fwd?)\s*:)+/, "");
  let pos = 0;
  for (const [re, w] of POSITIVE) if (re.test(s)) pos += w;
  pos = Math.min(pos, 9);
  let neg = 0;
  for (const [re, w] of NEGATIVE) if (re.test(s)) neg += w;
  return pos - Math.min(neg, 9);
}

export function prefilter(meta: MessageMetadata, config: PrefilterConfig): PrefilterResult {
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const addr = parseFromAddress(meta.from);
  const labels = new Set((meta.labels ?? []).map((l) => l.toUpperCase()));

  if (addr && config.ignoredDomains.some((d) => isSameOrSubdomain(addr.domain, d))) {
    return { decision: "out", reason: "ignored_domain", score: 0 };
  }
  if (labels.has("CATEGORY_PROMOTIONS")) return { decision: "out", reason: "promotions", score: 0 };
  if (labels.has("CATEGORY_SOCIAL") || labels.has("CATEGORY_FORUMS")) {
    return { decision: "out", reason: "social", score: 0 };
  }
  if (addr && config.watchedDomains.some((d) => isSameOrSubdomain(addr.domain, d))) {
    return { decision: "continue", reason: "watched_domain", score: threshold };
  }

  let score = scoreSubject(meta.subject);
  if (addr) {
    if (SENDER_POSITIVE.test(addr.local)) score += 1;
    if (SENDER_NEGATIVE.test(addr.local)) score -= 2;
  }
  if (meta.listId) score -= 1;
  return score >= threshold
    ? { decision: "continue", reason: "keyword_score", score }
    : { decision: "out", reason: "low_score", score };
}
