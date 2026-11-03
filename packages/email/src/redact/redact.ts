// email.redact (BACKEND_PLAN §7.8.2, hard rules 7 and 8). Pure string to string; no I/O.
//
// Masks, in this order:
//   1. invisible characters, non-ASCII decimal digits folded to ASCII, every whitespace except "\n" -> " "
//      (so digits cannot be split or disguised to dodge the masks)
//   2. email addresses other than the sender's own organisation, including "[at]"/"[dot]" forms -> [email]
//   3. SSNs (fully)                                          -> [ssn]
//   4. phone numbers, US and international (fully)           -> [phone]
//   5. keyworded ids (policy, account, member, ...)          -> [acct ••••1234]   (last 4 kept)
//   6. long digit runs of 8+ digits, Luhn-valid ones as cards -> [card ••••1234] / [acct ••••1234]
// Amounts ($1,234.56, 12345678.90) and dates (2026-11-04, 11/04/2026) are never touched.
//
// Every pattern is linear: quantifiers are bounded, there are no nested unbounded quantifiers, the email
// scan is index-based and the keyword scan looks at a fixed-size window. Regression tests with runtime
// budgets live in redact.hardening.test.ts.
//
// Evidence quotes (BACKEND_PLAN §7.8.2 validation rule 1) are checked against THIS masked text, so a quote
// that contains a masked value must use the masked form, e.g. "Policy [acct ••••4410]".
import { isFreeMailDomain, sameOrganisation } from "../match/domain.js";

export interface RedactOptions {
  /** Domain of the message sender. Addresses on this organisation are kept. */
  senderDomain?: string | null;
}

export interface RedactCounts {
  email: number;
  ssn: number;
  phone: number;
  card: number;
  account: number;
}

export interface RedactResult {
  text: string;
  counts: RedactCounts;
}

const MASK_DOT = "••••";

/** Characters that carry no visible text but can split a number or hide instructions. */
/* eslint-disable no-misleading-character-class -- format characters are the point */
const INVISIBLE =
  /[\u00AD͏\u061Cᅟᅠ឴឵᠋-᠏\u200B-\u200F\u202A-\u202E\u2060-\u206Fㅤ︀-️\uFEFFﾠ\u{E0000}-\u{E007F}]/gu;
/* eslint-enable no-misleading-character-class */

/** Removes invisible/format characters. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "");
}

const ND = /\p{Nd}/u;
const ND_ANY = /\P{ASCII}/u;

/**
 * Maps every Unicode decimal digit (Arabic-Indic, Devanagari, full-width, ...) to ASCII 0-9. Decimal digit
 * blocks are runs of ten consecutive code points starting at the zero, so the value is the offset from
 * the start of the run, modulo 10.
 */
export function foldDigits(s: string): string {
  if (!ND_ANY.test(s)) return s;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128 || !ND.test(ch)) {
      out += ch;
      continue;
    }
    let start = cp;
    for (let i = 0; i < 40 && ND.test(String.fromCodePoint(start - 1)); i++) start--;
    out += String((cp - start) % 10);
  }
  return out;
}

const LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;

/** An address is the sender's own when it is on the same organisation (not for consumer webmail). */
function isSenderDomain(domain: string, sender: string | null): boolean {
  if (!sender || isFreeMailDomain(sender)) return false;
  return sameOrganisation(domain, sender);
}

function maskEmails(text: string, sender: string | null, counts: RedactCounts): string {
  if (!text.includes("@")) return text;
  const out: string[] = [];
  let cursor = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > cursor && at - start < MAX_LOCAL && LOCAL_CHAR.test(text[start - 1]!)) start--;
    let end = at + 1;
    while (end < text.length && end - at < MAX_DOMAIN && DOMAIN_CHAR.test(text[end]!)) end++;
    // Trim trailing punctuation that belongs to the sentence, not the address.
    while (end > at + 1 && /[.-]/.test(text[end - 1]!)) end--;
    const local = text.slice(start, at);
    const domain = text.slice(at + 1, end);
    const valid = local.length > 0 && /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}$/u.test(domain);
    if (valid && !isSenderDomain(domain, sender)) {
      out.push(text.slice(cursor, start), "[email]");
      counts.email++;
      cursor = end;
      at = text.indexOf("@", end);
    } else {
      at = text.indexOf("@", at + 1);
    }
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/** "bob [at] example [dot] com", "bob(at)example(dot)co(dot)uk". Always masked. */
const OBFUSCATED_EMAIL =
  /[\p{L}\p{N}._%+-]{1,64} ?[[(] ?at ?[\])] ?[\p{L}\p{N}-]{1,63}(?: ?[[(] ?dot ?[\])] ?[\p{L}\p{N}-]{1,63}){1,4}/giu;

const SSN_DASHED = /(?<!\d)\d{3}[- .]\d{2}[- .]\d{4}(?!\d)/g;
const SSN_KEYWORD = /\b(?:ssn|social security(?: number| no\.?| #)?)[^\w\n]{0,4}\d{9}(?!\d)/gi;

const PHONE_INTL = /(?<!\w)\+\d{1,3}(?:[ .\-()]{0,3}\d){7,14}(?!\d)/g;
const PHONE_US = /(?<![\d$.,-])(?:\+?1[ .-])?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?!\d)/g;

const ID_KEYWORD =
  /\b(?:policy|account|acct|member|subscriber|group|loan|certificate|customer|contract|routing)\b/gi;
/** Characters scanned after a keyword, and how far into them the token may start (about 20 of filler). */
const KEYWORD_WINDOW = 44;
const KEYWORD_FILLER = 22;
const TOKEN = /[A-Za-z0-9][A-Za-z0-9-]{5,}/g;
const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 8+ digits as one run, or as groups of 3+ digits joined by one separator (space, dot, hyphen, or a single
 * newline). Not part of an amount.
 */
const DIGIT_RUN = /(?<![\d$.,])\d{3,}(?:(?: {1,2}| ?[.-] ?| ?\n ?)\d{3,})*(?!\d)(?![.,]\d)/g;

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function maskId(kind: "acct" | "card", token: string): string {
  const tail = token.replace(/[^A-Za-z0-9]/g, "").slice(-4);
  return `[${kind} ${MASK_DOT}${tail}]`;
}

/** Keyworded ids: first qualifying token within a fixed window after the keyword, on the same line. */
function maskKeywordedIds(text: string, counts: RedactCounts): string {
  const out: string[] = [];
  let cursor = 0;
  ID_KEYWORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_KEYWORD.exec(text)) !== null) {
    const from = m.index + m[0].length;
    if (from < cursor) continue;
    let windowEnd = Math.min(text.length, from + KEYWORD_WINDOW);
    const nl = text.indexOf("\n", from);
    if (nl !== -1 && nl < windowEnd) windowEnd = nl;
    const win = text.slice(from, windowEnd);
    TOKEN.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = TOKEN.exec(win)) !== null) {
      if (tm.index > KEYWORD_FILLER) break;
      const token = tm[0];
      const before = tm.index === 0 ? text[from - 1] : win[tm.index - 1];
      const after = win.slice(tm.index + token.length, tm.index + token.length + 2);
      if (digitsOf(token).length < 4) continue; // "account summary"
      if (DATE_ISO.test(token)) continue;
      if (before === "$" || /^[.,]\d/.test(after)) continue; // amounts
      const abs = from + tm.index;
      out.push(text.slice(cursor, abs), maskId("acct", token));
      counts.account++;
      cursor = abs + token.length;
      ID_KEYWORD.lastIndex = cursor;
      break;
    }
  }
  out.push(text.slice(cursor));
  return out.join("");
}

export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  const counts: RedactCounts = { email: 0, ssn: 0, phone: 0, card: 0, account: 0 };
  const sender = opts.senderDomain ? opts.senderDomain.toLowerCase().replace(/^\.+/, "") : null;

  let t = foldDigits(stripInvisible(input)).replace(/[^\S\n]/g, " ");
  t = t.replace(OBFUSCATED_EMAIL, () => (counts.email++, "[email]"));
  t = maskEmails(t, sender, counts);

  t = t.replace(SSN_KEYWORD, () => (counts.ssn++, "[ssn]"));
  t = t.replace(SSN_DASHED, () => (counts.ssn++, "[ssn]"));
  t = t.replace(PHONE_INTL, () => (counts.phone++, "[phone]"));
  t = t.replace(PHONE_US, () => (counts.phone++, "[phone]"));

  t = maskKeywordedIds(t, counts);

  t = t.replace(DIGIT_RUN, (run: string) => {
    const digits = digitsOf(run);
    if (digits.length < 8) return run;
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      counts.card++;
      return maskId("card", digits);
    }
    counts.account++;
    return maskId("acct", digits);
  });

  return { text: t, counts };
}
