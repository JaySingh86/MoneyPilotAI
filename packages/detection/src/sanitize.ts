// Text hygiene for imported cells (hard rules 7 and 8, CSV formula injection).
//
// Imported text can later be exported (WP-24 ZIP of CSV, a user opening a download in a spreadsheet), so a cell that
// starts with = + - @ tab or CR would run as a formula. `neutralizeFormula` prefixes a single quote, the OWASP
// recommendation; `csvCell` is the one place a future exporter should call. Long digit runs (account or card numbers)
// are cut to their last 4 before anything is stored.

/** C0 and C1 control characters and the Unicode line/paragraph separators. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}
const stripControl = (text: string): string =>
  Array.from(text, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? " " : ch)).join("");
const FORMULA_START = /^[=+\-@\t\r]/;
const LONG_NUMBER = /\d(?:[ -]?\d){8,}/g;

export const MAX_TEXT_CHARS = 200;

/** A leading = + - @ (or tab / CR) would be read as a formula by a spreadsheet; a quote makes it text. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Replaces any run of 9 or more digits (spaces and dashes allowed between them) with `****` and the last 4. */
export function maskLongNumbers(text: string): string {
  return text.replace(LONG_NUMBER, (run) => `****${run.replace(/\D/g, "").slice(-4)}`);
}

/**
 * The stored form of a free-text cell: control characters become spaces, numbers are masked, whitespace is
 * collapsed, formulas are neutralised, and the length is capped.
 */
export function cleanText(text: string, max = MAX_TEXT_CHARS): string {
  const collapsed = maskLongNumbers(stripControl(text)).replace(/\s+/g, " ").trim();
  return neutralizeFormula(collapsed).slice(0, max);
}

/** The last 4 digits of an account cell, or null when it has fewer than 4 digits. Never more (hard rule 7). */
export function accountLast4(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** A value for a CSV cell in an export: quoted when needed, and formulas neutralised. */
export function csvCell(value: string): string {
  const safe = neutralizeFormula(value).replace(/\r\n?/g, "\n");
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
