// Output escaping for every template. User text (household and first names, item names) is untrusted display
// text: it is escaped for the context it lands in and never trusted as markup.

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The exact inverse of {@link escapeHtml} (and of the API's own `escapeHtml`, which the invite flow applies
 * before handing names over, apps/api households service). `&amp;` is decoded last so `&amp;lt;` becomes
 * `&lt;`, not `<`. Only these five entities are decoded.
 */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * One line of safe header text: control characters (CR and LF included, so no header injection) and the
 * Unicode line and paragraph separators become spaces, runs of whitespace collapse, and the result is cut to
 * `max` characters.
 */
export function singleLine(text: string, max = 120): string {
  const clean = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
