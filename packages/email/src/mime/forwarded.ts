// Original-sender domain of a forwarded message (BACKEND_PLAN §7.8.1: forwarded mail arrives From the
// member). Best effort and UNAUTHENTICATED: it is text the forwarder's mail client wrote, or a header any
// sender can set. It may help the matcher find the right item; it must never be the basis for auto-apply.
import { normalizeDomain } from "../match/domain.js";

export interface OriginalSender {
  domain: string;
  source: "forward_block" | "header";
}

const MARKERS = ["forwarded message", "begin forwarded message", "original message", "forwarded by"];
const HEADER_KEYS = ["resent-from", "x-original-from", "x-original-sender", "x-forwarded-for"];
const FROM_LINE = /^[ \t>]{0,8}(?:from|de|von)[ \t]{0,3}:[ \t]{0,3}(.{1,200})$/im;

function domainOfAddressText(s: string): string | null {
  const angled = /<([^<>\s]{1,200})>/.exec(s);
  const bare = /([^\s<>"',;]{1,100}@[^\s<>"',;]{1,150})/.exec(s);
  const addr = angled?.[1] ?? bare?.[1];
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  return at < 1 ? null : normalizeDomain(addr.slice(at + 1));
}

export function findOriginalSenderDomain(
  bodyText: string,
  headers: readonly { key: string; value: string }[],
): OriginalSender | null {
  const lower = bodyText.toLowerCase();
  let idx = -1;
  for (const m of MARKERS) {
    const i = lower.indexOf(m);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx !== -1) {
    const m = FROM_LINE.exec(bodyText.slice(idx, idx + 800));
    const d = m ? domainOfAddressText(m[1]!) : null;
    if (d) return { domain: d, source: "forward_block" };
  }
  for (const h of headers) {
    if (!HEADER_KEYS.includes(h.key.toLowerCase())) continue;
    const d = domainOfAddressText(h.value.slice(0, 500));
    if (d) return { domain: d, source: "header" };
  }
  return null;
}
