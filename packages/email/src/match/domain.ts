// Domain helpers shared by redaction, prefilter and the matcher. Pure. No public-suffix list: a small
// heuristic for country-code second-level domains is enough because every use is an equality or
// dot-boundary check against a domain we already hold.

const CC_SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

/** Consumer mailbox providers. A sender here says nothing about which company wrote the message. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "zoho.com",
  "fastmail.com",
]);

export function isFreeMailDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  return d !== null && FREE_MAIL.has(orgDomain(d));
}

/** Lower-cases and strips a trailing dot. Returns null for anything that is not a plausible hostname. */
export function normalizeDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const v = d.trim().toLowerCase().replace(/\.+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/**
 * TODO(WP-22): replace this heuristic with the Public Suffix List (e.g. `tldts`). It mis-handles registry
 * suffixes such as `github.io` or `co.in`, which matters once auto-apply trusts organisation-level matches.
 *
 * `billing.lakeside-auto.example` ->`lakeside-auto.example`; `mail.foo.co.uk` -> `foo.co.uk`. */
export function orgDomain(domain: string): string {
  const labels = domain.split(".");
  if (labels.length <= 2) return domain;
  const last = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const keep = last.length === 2 && CC_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** True when `host` is `base` or a subdomain of it, on a dot boundary. */
export function isSameOrSubdomain(host: string, base: string): boolean {
  const h = normalizeDomain(host);
  const b = normalizeDomain(base);
  if (!h || !b) return false;
  return h === b || h.endsWith("." + b);
}

/** Same organisation: both share the organisational domain (`mail.x.example` ~ `x.example`). */
export function sameOrganisation(a: string, b: string): boolean {
  const x = normalizeDomain(a);
  const y = normalizeDomain(b);
  if (!x || !y) return false;
  return orgDomain(x) === orgDomain(y);
}
