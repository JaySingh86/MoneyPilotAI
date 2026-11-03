// HTML to text with hidden-content removal. Email HTML is untrusted input (hard rule 9).
//
// Step 1 (htmlparser2): rebuild a minimal, attribute-free HTML tree that omits everything a human reader
//   would not see: scripts/styles/comments, display:none and friends, aria-hidden, preheader text,
//   off-screen and zero-size text, same-colour text. Links lose their href (tracking URLs, secrets in query
//   strings); images are dropped.
// Step 2 (html-to-text): flatten the cleaned tree to text, keeping table cells apart so
//   "Premium | $684.00" does not become "Premium$684.00".
import { convert } from "html-to-text";
import { Parser } from "htmlparser2";

export const HTML_LIMITS = {
  /** Characters of HTML parsed. The rest is dropped and `truncated` is set. */
  maxInputChars: 1_000_000,
  /** Elements nested deeper than this are dropped (stack and CPU guard). */
  maxDepth: 100,
} as const;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "head",
  "title",
  "template",
  "noscript",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "audio",
  "video",
  "textarea",
  "select",
  "datalist",
  "meta",
  "link",
  "base",
]);

const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "base",
  "wbr",
  "area",
  "col",
  "source",
]);

const HIDDEN_CLASSES = new Set([
  "preheader",
  "preheadertext",
  "preview",
  "previewtext",
  "preview-text",
  "hidden",
  "hide",
  "visuallyhidden",
  "visually-hidden",
  "sr-only",
  "screenreader",
  "screen-reader-text",
]);

/** True when the inline style makes the element invisible to a human reader. */
export function styleHidesContent(style: string): boolean {
  const s = style
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/!important/g, "");
  if (!s) return false;
  if (/(^|;)display:none(;|$)/.test(s)) return true;
  if (/(^|;)visibility:(hidden|collapse)(;|$)/.test(s)) return true;
  if (/(^|;)opacity:0(\.0*)?(;|$)/.test(s)) return true;
  if (/(^|;)font-size:0(px|pt|em|rem|%)?(;|$)/.test(s)) return true;
  if (
    /(^|;)(line-height|max-height|height|max-width|width):0(px|pt|em|rem|%)?(;|$)/.test(s) &&
    /overflow:hidden/.test(s)
  )
    return true;
  if (/(^|;)mso-hide:all(;|$)/.test(s)) return true;
  if (/(^|;)color:transparent(;|$)/.test(s)) return true;
  if (/(^|;)text-indent:-\d{3,}/.test(s)) return true;
  if (/(^|;)(left|top|right|bottom|margin-left|margin-top):-\d{3,}/.test(s)) return true;
  if (/(^|;)clip:rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)/.test(s)) return true;
  // Same colour for text and its own background (white-on-white). A parent's background is not visible
  // here; that case is not detected (documented limitation).
  const color = /(?:^|;)color:([^;]+)/.exec(s)?.[1];
  const bg = /(?:^|;)background(?:-color)?:([^;]+)/.exec(s)?.[1];
  if (color && bg && normalizeColor(color) === normalizeColor(bg)) return true;
  return false;
}

function normalizeColor(c: string): string {
  const v = c.trim();
  if (v === "white" || v === "#fff" || v === "#ffffff" || v === "rgb(255,255,255)") return "#ffffff";
  if (v === "black" || v === "#000" || v === "#000000" || v === "rgb(0,0,0)") return "#000000";
  return v;
}

const MAX_CSS_CHARS = 100_000;

/**
 * Class names that a <style> block hides unconditionally (simple `.class` selectors only; rules inside
 * @media or other at-rules apply to some screens only and are ignored).
 */
export function hiddenClassesFromCss(css: string): Set<string> {
  const out = new Set<string>();
  for (const rule of css.slice(0, MAX_CSS_CHARS).split("}")) {
    const open = rule.indexOf("{");
    if (open === -1 || rule.includes("@")) continue;
    if (!styleHidesContent(rule.slice(open + 1))) continue;
    for (const sel of rule.slice(0, open).split(",")) {
      const m = /^\s*\.([\w-]+)\s*$/.exec(sel);
      if (m) out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

function elementHidden(attribs: Record<string, string>, cssHidden: ReadonlySet<string>): boolean {
  if ("hidden" in attribs) return true;
  if (attribs["aria-hidden"]?.toLowerCase() === "true") return true;
  if (attribs["type"]?.toLowerCase() === "hidden") return true;
  const cls = attribs["class"];
  if (cls) {
    for (const c of cls.toLowerCase().split(/\s+/))
      if (HIDDEN_CLASSES.has(c) || cssHidden.has(c)) return true;
  }
  const style = attribs["style"];
  return style !== undefined && styleHidesContent(style);
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface HtmlTextResult {
  text: string;
  truncated: boolean;
}

/** Cleans untrusted HTML down to visible text. Never throws. */
export function htmlToText(html: string): HtmlTextResult {
  let truncated = false;
  let input = html;
  if (input.length > HTML_LIMITS.maxInputChars) {
    input = input.slice(0, HTML_LIMITS.maxInputChars);
    truncated = true;
  }

  const out: string[] = [];
  const stack: { name: string; skips: boolean }[] = [];
  let skipDepth = 0; // > 0 while inside a hidden subtree
  const cssHidden = new Set<string>();
  let css = "";
  let inStyle = false;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const lname = name.toLowerCase();
        const void_ = VOID_TAGS.has(lname);
        const tooDeep = stack.length >= HTML_LIMITS.maxDepth;
        const skips = SKIP_TAGS.has(lname) || tooDeep || elementHidden(attribs, cssHidden);
        if (void_) {
          if (skipDepth === 0 && !skips && lname === "br") out.push("<br>");
          if (skipDepth === 0 && !skips && lname === "hr") out.push("<hr>");
          return;
        }
        stack.push({ name: lname, skips });
        if (lname === "style") {
          inStyle = true;
          css = "";
        }
        if (skips) skipDepth++;
        else if (skipDepth === 0) out.push(`<${lname}>`);
      },
      onclosetag(name) {
        const lname = name.toLowerCase();
        if (VOID_TAGS.has(lname)) return;
        // Tolerate mis-nested markup: close up to the matching open tag.
        let idx = stack.length - 1;
        while (idx >= 0 && stack[idx]!.name !== lname) idx--;
        if (idx === -1) return;
        while (stack.length > idx) {
          const e = stack.pop()!;
          if (e.name === "style") {
            inStyle = false;
            for (const c of hiddenClassesFromCss(css)) cssHidden.add(c);
            css = "";
          }
          if (e.skips) skipDepth--;
          else if (skipDepth === 0) {
            out.push(`</${e.name}>`);
            if (e.name === "td" || e.name === "th") out.push(" ");
          }
        }
      },
      ontext(data) {
        if (inStyle) {
          if (css.length < MAX_CSS_CHARS) css += data;
          return;
        }
        if (skipDepth === 0) out.push(escapeText(data));
      },
      // oncomment/oncdata/onprocessinginstruction are intentionally ignored.
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: false },
  );
  parser.write(input);
  parser.end();
  // Close anything still open so html-to-text sees balanced markup.
  const cleaned = out.join("");

  let text: string;
  try {
    text = convert(cleaned, {
      wordwrap: false,
      preserveNewlines: false,
      limits: { maxInputLength: 3_000_000, maxDepth: HTML_LIMITS.maxDepth + 10, ellipsis: "" },
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "table", format: "block" },
        { selector: "h1", options: { uppercase: false } },
        { selector: "h2", options: { uppercase: false } },
        { selector: "h3", options: { uppercase: false } },
        { selector: "h4", options: { uppercase: false } },
        { selector: "h5", options: { uppercase: false } },
        { selector: "h6", options: { uppercase: false } },
      ],
    });
  } catch {
    // Last resort: strip tags.
    text = cleaned.replace(/<[^>]*>/g, " ");
  }
  return { text, truncated };
}
