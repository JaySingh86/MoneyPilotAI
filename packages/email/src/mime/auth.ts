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

/**
 * Removes what RFC 8601 lets a sender-controlled value hide behind: `( ... )` comments (nested, with `\` escapes) and
 * quoted strings (their content becomes empty). What is left has only tokens the receiving MTA itself wrote, so a
 * `dmarc=pass` inside a comment or in `smtp.mailfrom="x dmarc=pass"@evil.com` can never be read as a verdict (S1).
 * Linear: one pass, no backtracking. An unterminated comment or string drops the rest of the value.
 */
export function stripCommentsAndQuotes(value: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\") {
      i++; // quoted-pair: the next character is data, whatever it is
      continue;
    }
    if (inString) {
      if (c === '"') inString = false;
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === "(") depth = 1;
    else if (c === '"') {
      inString = true;
      out += '""';
    } else out += c;
  }
  return out;
}

function authservIdOf(value: string): string | null {
  const first = value.slice(0, MAX_HEADER_CHARS).split(";", 1)[0]!.trim().split(/\s+/, 1)[0]!.toLowerCase();
  return /^[a-z0-9.-]{1,255}$/.test(first) && !first.includes("=") ? first : null;
}

export function parseAuthenticationResults(value: string, fromDomain: string | null): AuthenticationVerdicts {
  const clean = stripCommentsAndQuotes(value.slice(0, MAX_HEADER_CHARS));
  // The first segment is the authserv-id (and version); every later one is one result, `method=result prop=value ...`.
  // A method is read ONLY at the start of its segment, never from inside another segment's properties.
  const segments = clean.split(";").slice(1);
  const first = (method: string): { result: string; segment: string } | undefined => {
    for (const segment of segments) {
      const m = new RegExp(`^\\s*${method}\\s*=\\s*([a-z]+)`, "i").exec(segment);
      if (m) return { result: m[1]!, segment };
    }
    return undefined;
  };
  const dmarcSeg = first("dmarc");
  const dmarc = verdict(dmarcSeg?.result);
  const headerFrom = dmarcSeg ? /header\.from\s*=\s*([a-z0-9.-]+)/i.exec(dmarcSeg.segment)?.[1] : undefined;
  // `header.from` must be present and in the same organisation as the From domain: a bare `dmarc=pass` proves nothing.
  const aligned =
    dmarc === "pass" &&
    fromDomain !== null &&
    headerFrom !== undefined &&
    sameOrganisation(headerFrom, fromDomain);
  return {
    authservId: authservIdOf(clean),
    dkim: verdict(first("dkim")?.result),
    spf: verdict(first("spf")?.result),
    dmarc,
    dmarcAligned: aligned,
  };
}

/**
 * Picks the Authentication-Results header to read. With a trusted list: the first header whose authserv-id
 * is on it (headers are listed most recent first, so that is the receiver's own). Without a list: the first
 * header.
 */
export interface PickOptions {
  /** Only the top-most Authentication-Results header may be read (one the sender planted sits below ours). */
  topmostOnly?: boolean;
  /** Tokens (`name=`) the chosen header must contain outside comments and quotes, e.g. Exchange's `compauth=`. */
  requireTokens?: readonly string[];
}

export function pickAuthenticationResults(
  headers: readonly { key: string; value: string }[],
  trustedAuthservIds: readonly string[],
  options: PickOptions = {},
): string | null {
  let candidates = headers.filter((h) => h.key.toLowerCase() === "authentication-results");
  if (options.topmostOnly) candidates = candidates.slice(0, 1);
  let chosen: string | null = null;
  if (trustedAuthservIds.length === 0) chosen = candidates[0]?.value ?? null;
  else {
    const trusted = new Set(trustedAuthservIds.map((s) => s.toLowerCase()));
    for (const c of candidates) {
      const id = authservIdOf(c.value);
      if (id && trusted.has(id)) {
        chosen = c.value;
        break;
      }
    }
  }
  if (chosen !== null && options.requireTokens?.length) {
    const visible = stripCommentsAndQuotes(chosen.slice(0, MAX_HEADER_CHARS)).toLowerCase();
    if (!options.requireTokens.every((t) => visible.includes(t.toLowerCase()))) return null;
  }
  return chosen;
}
