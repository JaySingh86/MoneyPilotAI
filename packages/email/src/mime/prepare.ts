// email.fetch + email.redact in one call (BACKEND_PLAN §7.8.2): raw RFC 822 in, REDACTED text out.
//
// This is the only public path from raw message bytes to text. Unredacted text never leaves this function:
// the result has no field that carries it, and nothing is stored or logged here (hard rules 7 and 8).
import PostalMime from "postal-mime";
import { pdfToText } from "../pdf/extract.js";
import { redact, type RedactCounts } from "../redact/redact.js";
import {
  parseAuthenticationResults,
  pickAuthenticationResults,
  UNKNOWN_AUTH,
  type AuthenticationVerdicts,
} from "./auth.js";
import { findOriginalSenderDomain } from "./forwarded.js";
import { htmlToText } from "./html.js";
import { countMimeParts, MAX_MIME_PARTS } from "./mime-parts.js";
import { looksLikeInjection, neutralizeDelimiters, normalizeText } from "./sanitize.js";

export const EMAIL_LIMITS = {
  /** Raw message size accepted. Larger messages are refused without parsing. */
  maxRawBytes: 10 * 1024 * 1024,
  /** Total characters handed to the model (BACKEND_PLAN §7.8.2: cap 20k chars total). */
  maxTextChars: 20_000,
  /** Characters assembled before redaction (CPU guard); losing any of it also sets `truncated`. */
  maxPreRedactChars: 200_000,
  maxPdfAttachments: 3,
  maxNestingDepth: 32,
  maxHeadersBytes: 256 * 1024,
  maxSubjectChars: 300,
  /** Subject characters considered at all; the rest is dropped BEFORE redaction. */
  maxSubjectInputChars: 1_000,
  /** text/plain shorter than this, next to an HTML part, is treated as a stub ("view in browser"). */
  stubTextChars: 40,
} as const;

export type PrepareLimits = { [K in keyof typeof EMAIL_LIMITS]?: number };

export interface PrepareOptions {
  limits?: PrepareLimits;
  /**
   * authserv-ids whose Authentication-Results header may be read (the receiver's own id). Empty or missing:
   * the top-most header is used. Verdicts are only meaningful when the receiver strips inbound copies.
   */
  trustedAuthservIds?: string[];
  /** Stricter reading of the header (S4): top-most only, and tokens only the receiving system writes. */
  authenticationPolicy?: { topmostOnly?: boolean; requireTokens?: string[] };
}

/** `parse_limit`: the message hit a parsing limit (too many MIME parts, an inflate bomb, time, memory). */
export type PrepareFailure = "too_large" | "malformed" | "empty" | "parse_limit";

export type PrepareNote =
  | "html_used"
  | "text_used"
  | "pdf_used"
  | "pdf_skipped_too_large"
  | "pdf_skipped_too_many_pages"
  | "pdf_skipped_encrypted"
  | "pdf_skipped_invalid"
  | "pdf_skipped_timeout"
  | "pdf_skipped_empty"
  | "pdf_skipped_over_limit"
  | "attachment_ignored"
  | "injection_suspected"
  /** The body or subject tried to open or close the `<email>` fence around the text; the markers were defused. */
  | "fence_tampered"
  | "html_truncated";

export interface PreparedEmail {
  ok: true;
  /** Lower-case domain of the From address, or null. */
  senderDomain: string | null;
  /** Redacted, delimiter-safe, at most `maxSubjectChars`. */
  subject: string;
  /** Redacted, delimiter-safe, at most `maxTextChars` characters. */
  text: string;
  /** True when anything was cut (20k cap, pre-redaction cap, oversized HTML or PDF). BACKEND_PLAN rule 6. */
  truncated: boolean;
  redactionCounts: RedactCounts;
  notes: PrepareNote[];
  /** Parsed Authentication-Results verdicts (never the raw header). See auth.ts for the trust caveat. */
  authentication: AuthenticationVerdicts;
  /**
   * Domain of the original sender of a FORWARDED message, from the forwarded-message block or a Resent-From
   * style header. Best effort and UNAUTHENTICATED: use it to find the item, never to authorise auto-apply.
   */
  originalSenderDomain: string | null;
  originalSenderSource: "forward_block" | "header" | null;
}

export type PrepareResult = PreparedEmail | { ok: false; reason: PrepareFailure };

function domainOf(address: string | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const d = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  return /^[a-z0-9.-]+$/.test(d) && d.includes(".") ? d : null;
}

/**
 * Runs the whole pipeline IN THIS THREAD. Only the sandbox worker and unit tests call this; production code
 * uses `prepareEmail` from ./sandbox.js, which isolates it (memory cap, hard timeout, terminate()).
 */
export async function prepareEmailInProcess(
  raw: string | Uint8Array,
  opts: PrepareOptions = {},
): Promise<PrepareResult> {
  const L = { ...EMAIL_LIMITS, ...opts.limits };
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (bytes.length > L.maxRawBytes) return { ok: false, reason: "too_large" };
  if (countMimeParts(bytes) > MAX_MIME_PARTS) return { ok: false, reason: "parse_limit" };

  let parsed: Awaited<ReturnType<PostalMime["parse"]>>;
  try {
    parsed = await new PostalMime({
      maxNestingDepth: L.maxNestingDepth,
      maxHeadersSize: L.maxHeadersBytes,
      attachmentEncoding: "arraybuffer",
    }).parse(bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const notes = new Set<PrepareNote>();
  let truncated = false;

  // 1. Body: prefer text/plain; fall back to HTML when text is missing or a stub.
  const plain = normalizeText(parsed.text ?? "");
  let body = plain;
  if (parsed.html && plain.length < L.stubTextChars) {
    const h = htmlToText(parsed.html);
    if (h.truncated) {
      truncated = true;
      notes.add("html_truncated");
    }
    const fromHtml = normalizeText(h.text);
    if (fromHtml.length > plain.length) {
      body = fromHtml;
      notes.add("html_used");
    }
  }
  if (body === plain && plain.length > 0) notes.add("text_used");

  // 2. Attachments: PDFs only. Everything else (zip, images, office files, nested messages) is ignored
  //    unread, so archive bombs never get opened.
  let pdfCount = 0;
  const chunks: string[] = body ? [body] : [];
  for (const a of parsed.attachments ?? []) {
    const content = a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : null;
    const looksPdf =
      content !== null &&
      (a.mimeType?.toLowerCase() === "application/pdf" ||
        /\.pdf$/i.test(a.filename ?? "") ||
        new TextDecoder("latin1").decode(content.subarray(0, 8)).startsWith("%PDF-"));
    if (!looksPdf || content === null) {
      notes.add("attachment_ignored");
      continue;
    }
    if (pdfCount >= L.maxPdfAttachments) {
      notes.add("pdf_skipped_over_limit");
      continue;
    }
    pdfCount++;
    const r = await pdfToText(content);
    if (!r.ok && r.reason === "inflate_limit") return { ok: false, reason: "parse_limit" };
    if (!r.ok) {
      notes.add(`pdf_skipped_${r.reason}` as PrepareNote);
      continue;
    }
    notes.add("pdf_used");
    if (r.truncated) truncated = true;
    chunks.push("--- PDF attachment ---\n" + normalizeText(r.text));
  }

  let assembled = chunks.join("\n\n");
  if (assembled.length > L.maxPreRedactChars) {
    assembled = assembled.slice(0, L.maxPreRedactChars);
    truncated = true;
  }

  const senderDomain = domainOf(parsed.from?.address);
  const forwarded = findOriginalSenderDomain(assembled.slice(0, 60_000), parsed.headers ?? []);
  const authHeader = pickAuthenticationResults(
    parsed.headers ?? [],
    opts.trustedAuthservIds ?? [],
    opts.authenticationPolicy ?? {},
  );
  const authentication = authHeader ? parseAuthenticationResults(authHeader, senderDomain) : UNKNOWN_AUTH;

  const redactOpts = { senderDomain };
  const body2 = redact(assembled, redactOpts);
  const subj = redact(normalizeText((parsed.subject ?? "").slice(0, L.maxSubjectInputChars)), redactOpts);

  let text = neutralizeDelimiters(body2.text);
  // The model call can no longer see that the text tried to close its fence (it is defused here), so say so (S2).
  const subjectText = neutralizeDelimiters(subj.text);
  if (text !== body2.text || subjectText !== subj.text) notes.add("fence_tampered");
  if (text.length > L.maxTextChars) {
    text = text.slice(0, L.maxTextChars);
    truncated = true;
  }
  if (text.trim().length === 0) return { ok: false, reason: "empty" };
  if (looksLikeInjection(text) || looksLikeInjection(subj.text)) notes.add("injection_suspected");

  const counts: RedactCounts = {
    email: body2.counts.email + subj.counts.email,
    ssn: body2.counts.ssn + subj.counts.ssn,
    phone: body2.counts.phone + subj.counts.phone,
    card: body2.counts.card + subj.counts.card,
    account: body2.counts.account + subj.counts.account,
  };

  return {
    ok: true,
    senderDomain,
    subject: subjectText.slice(0, L.maxSubjectChars),
    text,
    truncated,
    redactionCounts: counts,
    notes: [...notes],
    authentication,
    originalSenderDomain: forwarded?.domain ?? null,
    originalSenderSource: forwarded?.source ?? null,
  };
}
