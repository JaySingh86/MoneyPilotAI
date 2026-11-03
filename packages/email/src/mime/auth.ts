// Authentication-Results handling (Q-062). Only parsed verdicts leave this module, never the raw header.
//
// TRUST: a header inside a message is only as trustworthy as the system that wrote it. The receiver (SES, or
// the Gmail/Graph layer) must strip any inbound Authentication-Results and add its own; callers pass the
// authserv-ids they trust. For forwarded mail the verdict is about the forwarder, not the original sender
// (WP-22 decides what to do with that).
import { sameOrganisation } from "../match/domain.js";

export type Verdict = "pass" | "fail" | "none" | "unknown";

export interface AuthenticationVerdicts {
  /** Hostname that produced the verdicts (the header's authserv-id). */
  authservId: string | null;
  dkim: Verdict;
  spf: Verdict;
  dmarc: Verdict;
  /** DMARC passed AND its header.from belongs to the same organisation as the From domain. */
  dmarcAligned: boolean;
}

export const UNKNOWN_AUTH: AuthenticationVerdicts = {
  authservId: null,
  dkim: "unknown",
  spf: "unknown",
  dmarc: "unknown",
  dmarcAligned: false,
};

const MAX_HEADER_CHARS = 4096;

function verdict(raw: string | undefined): Verdict {
  if (!raw) return "unknown";
  const v = raw.toLowerCase();
  if (v === "pass") return "pass";
  if (v === "none") return "none";
  return "fail"; // fail, softfail, neutral, temperror, permerror, policy
}

function authservIdOf(value: string): string | null {
  const first = value.slice(0, MAX_HEADER_CHARS).split(";", 1)[0]!.trim().split(/\s+/, 1)[0]!.toLowerCase();
  return /^[a-z0-9.-]{1,255}$/.test(first) && !first.includes("=") ? first : null;
}

export function parseAuthenticationResults(value: string, fromDomain: string | null): AuthenticationVerdicts {
  const v = value.slice(0, MAX_HEADER_CHARS);
  const find = (method: string) => new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i").exec(v)?.[1];
  const dmarc = verdict(find("dmarc"));
  const headerFrom = /dmarc=[^;]*?header\.from=([a-z0-9.-]+)/i.exec(v)?.[1];
  const aligned =
    dmarc === "pass" &&
    fromDomain !== null &&
    (headerFrom === undefined || sameOrganisation(headerFrom, fromDomain));
  return {
    authservId: authservIdOf(v),
    dkim: verdict(find("dkim")),
    spf: verdict(find("spf")),
    dmarc,
    dmarcAligned: aligned,
  };
}

/**
 * Picks the Authentication-Results header to read. With a trusted list: the first header whose authserv-id
 * is on it (headers are listed most recent first, so that is the receiver's own). Without a list: the first
 * header.
 */
export function pickAuthenticationResults(
  headers: readonly { key: string; value: string }[],
  trustedAuthservIds: readonly string[],
): string | null {
  const candidates = headers.filter((h) => h.key.toLowerCase() === "authentication-results");
  if (trustedAuthservIds.length === 0) return candidates[0]?.value ?? null;
  const trusted = new Set(trustedAuthservIds.map((s) => s.toLowerCase()));
  for (const c of candidates) {
    const id = authservIdOf(c.value);
    if (id && trusted.has(id)) return c.value;
  }
  return null;
}
