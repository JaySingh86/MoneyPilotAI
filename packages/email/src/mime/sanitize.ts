// Text hygiene shared by the plain-text and HTML paths. Pure functions.
import { stripInvisible } from "../redact/redact.js";

/**
 * The extraction prompt wraps the message in an `<email>` block (BACKEND_PLAN §7.8.2, prompt-injection
 * posture). Body text must not be able to close or reopen that block, so any `<email`, `</email`,
 * `< / email`, `<email attr=…>` or full-width `＜／email＞` opener becomes a harmless look-alike. Evidence
 * quotes are matched against this same sanitised text.
 */
export function neutralizeDelimiters(s: string): string {
  return s.replace(/[<＜]([\s\u3000]{0,8}[/／]?[\s\u3000]{0,8})(email)/gi, "‹$1$2");
}

/**
 * NFKC (folds full-width characters and ligatures to ASCII), strips invisibles and control characters, and
 * turns EVERY whitespace character except "\n" into a single space. That includes U+1680, U+2028, U+2029
 * and U+3000, which would otherwise slip past patterns that only look for [ \t].
 */
export function normalizeText(s: string): string {
  return (
    stripInvisible(s.normalize("NFKC"))
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/[^\S\n]/g, " ")
      .replace(/ {2,}/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)/i,
  /\b(system|assistant|developer)\s*(prompt|message|:)/i,
  /you\s+are\s+now\s+(in\s+)?(an?\s+)?(admin|developer|dan|jailbreak|unrestricted)/i,
  /\b(reveal|print|show|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /<\s*\/?\s*(system|instructions?|tool_?call|function_?call)/i,
];

/**
 * Heuristic flag only. The text is NOT altered or dropped: the defences are structural (no tools on the
 * extraction call, schema-only output, evidence validation). A flagged message is never auto-applied
 * (BACKEND_PLAN §7.8.2 auto-apply policy, enforced in WP-22).
 */
export function looksLikeInjection(s: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(s));
}
