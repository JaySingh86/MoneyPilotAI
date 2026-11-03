// PDF to text (BACKEND_PLAN §7.8.2 email.fetch). pdfjs-dist, legacy build for Node.
// The PDF is untrusted input: hard limits on size, pages, output length and time; no scripting, no fetching,
// no fonts loaded from the network, no XFA. Output is raw text and MUST pass through redact before leaving
// the package (see prepare in ../mime).
import type * as PdfJsModule from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { inflateSync } from "node:zlib";

export const PDF_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPages: 10,
  maxChars: 200_000,
  timeoutMs: 8_000,
  /** Total bytes all Flate streams may inflate to (deflate-bomb guard). */
  maxInflatedBytes: 32 * 1024 * 1024,
} as const;

export type PdfLimits = { [K in keyof typeof PDF_LIMITS]?: number };

export type PdfFailure =
  "too_large" | "too_many_pages" | "encrypted" | "invalid" | "timeout" | "empty" | "inflate_limit";

export type PdfResult =
  { ok: true; text: string; pages: number; truncated: boolean } | { ok: false; reason: PdfFailure };

type PdfJs = typeof PdfJsModule;
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJs>;
  return pdfjsPromise;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/**
 * Deflate-bomb guard. Inflates every Flate-looking stream with a hard output cap before pdfjs is allowed to
 * look at the file, so a few KB cannot expand to gigabytes inside the parser. Streams that fail to inflate
 * for other reasons are left to pdfjs.
 */
function exceedsInflateBudget(bytes: Uint8Array, budget: number): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buf.toString("latin1");
  let remaining = budget;
  let from = 0;
  for (let n = 0; n < 5000; n++) {
    const s = text.indexOf("stream", from);
    if (s === -1) break;
    let start = s + 6;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    const end = text.indexOf("endstream", start);
    if (end === -1) break;
    from = end + 9;
    if (buf[start] !== 0x78 || end - start < 6) continue; // zlib header
    try {
      const out = inflateSync(buf.subarray(start, end), { maxOutputLength: Math.max(remaining, 1) });
      remaining -= out.length;
      if (remaining <= 0) return true;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ERR_BUFFER_TOO_LARGE") return true;
    }
  }
  return false;
}

export async function pdfToText(bytes: Uint8Array, limits: PdfLimits = {}): Promise<PdfResult> {
  const maxBytes = limits.maxBytes ?? PDF_LIMITS.maxBytes;
  const maxPages = limits.maxPages ?? PDF_LIMITS.maxPages;
  const maxChars = limits.maxChars ?? PDF_LIMITS.maxChars;
  const timeoutMs = limits.timeoutMs ?? PDF_LIMITS.timeoutMs;

  if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };
  if (!hasPdfHeader(bytes)) return { ok: false, reason: "invalid" };
  if (exceedsInflateBudget(bytes, limits.maxInflatedBytes ?? PDF_LIMITS.maxInflatedBytes)) {
    return { ok: false, reason: "inflate_limit" };
  }

  // Load the library before the clock starts: a cold import is not the PDF's fault.
  let pdfjs: PdfJs;
  try {
    pdfjs = await loadPdfJs();
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const deadline = Date.now() + timeoutMs; // elapsed-time budget only, not calendar logic
  let doc: PDFDocumentProxy | null = null;
  let loadingTask: { destroy(): Promise<void> } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const work = async (): Promise<PdfResult> => {
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes), // pdfjs takes ownership of the buffer
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      stopAtErrors: false,
      verbosity: 0,
      maxImageSize: 1024 * 1024,
    });
    loadingTask = task;
    doc = await task.promise;
    if (doc.numPages > maxPages) return { ok: false, reason: "too_many_pages" };
    let text = "";
    let truncated = false;
    for (let p = 1; p <= doc.numPages; p++) {
      if (Date.now() > deadline) return { ok: false, reason: "timeout" };
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) line += "\n";
        else if (item.str && !line.endsWith(" ")) line += " ";
        if (text.length + line.length > maxChars + 1024) break;
      }
      text += line.trimEnd() + "\n";
      page.cleanup();
      if (text.length > maxChars) {
        truncated = true;
        text = text.slice(0, maxChars);
        break;
      }
    }
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    if (text.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, text, pages: doc.numPages, truncated };
  };

  try {
    const r = await Promise.race([work(), timeout]);
    return r === "timeout" ? { ok: false, reason: "timeout" } : r;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "PasswordException") return { ok: false, reason: "encrypted" };
    return { ok: false, reason: "invalid" };
  } finally {
    clearTimeout(timer);
    try {
      await (loadingTask as { destroy(): Promise<void> } | null)?.destroy();
    } catch {
      /* best effort */
    }
  }
}
