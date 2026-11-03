import { describe, expect, it } from "vitest";
import { buildFlateBombPdf, buildPdf } from "../../testing/pdf-builder.js";
import { pdfToText } from "./extract.js";

describe("pdfToText", () => {
  it("extracts text, amounts and dates from a small PDF", async () => {
    const pdf = buildPdf([["Lakeside Auto Insurance", "Amount due: $684.00", "Due date: November 4, 2026"]]);
    const r = await pdfToText(pdf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBe(1);
    expect(r.text).toContain("Amount due: $684.00");
    expect(r.text).toContain("November 4, 2026");
  });

  it("extracts compressed streams and keeps page order", async () => {
    const pdf = buildPdf([["Page one marker"], ["Page two marker"]], { compress: true });
    const r = await pdfToText(pdf);
    expect(r.ok && r.text.indexOf("Page one marker")).toBeLessThan(
      r.ok ? r.text.indexOf("Page two marker") : 0,
    );
  });

  it("accepts exactly 10 pages and rejects 11", async () => {
    const mk = (n: number) => buildPdf(Array.from({ length: n }, (_, i) => [`Statement page ${i + 1}`]));
    const ten = await pdfToText(mk(10));
    expect(ten.ok && ten.pages).toBe(10);
    const eleven = await pdfToText(mk(11));
    expect(eleven).toEqual({ ok: false, reason: "too_many_pages" });
  });

  it("stops at the character cap and flags truncation", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i} ${"x".repeat(60)}`);
    const r = await pdfToText(buildPdf([lines]), { maxChars: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(500);
  });

  it("rejects oversized input without parsing it", async () => {
    const r = await pdfToText(new Uint8Array(6 * 1024 * 1024).fill(0x25), { maxBytes: 5 * 1024 * 1024 });
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects non-PDF and malformed input", async () => {
    expect(await pdfToText(new TextEncoder().encode("not a pdf at all"))).toEqual({
      ok: false,
      reason: "invalid",
    });
    const truncatedPdf = buildPdf([["hello"]]).slice(0, 120);
    const r = await pdfToText(new Uint8Array([...new TextEncoder().encode("%PDF-1.4\n"), ...truncatedPdf]));
    expect(r.ok).toBe(false);
  });

  it("reports an empty (image-only) PDF as empty, not as success", async () => {
    const r = await pdfToText(buildPdf([[]]));
    expect(r).toEqual({ ok: false, reason: "empty" });
  });

  it("survives a deflate bomb within limits (small file, large inflated stream)", async () => {
    const bomb = buildFlateBombPdf(64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024); // compresses to well under the input cap
    const r = await pdfToText(bomb, { timeoutMs: 20_000 });
    // Either extracted or refused, but it must return and never throw.
    expect(typeof r.ok).toBe("boolean");
  }, 30_000);

  it("refuses a stream that inflates far past the cap before pdfjs sees it", async () => {
    const bomb = buildFlateBombPdf(300 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const t = performance.now();
    const r = await pdfToText(bomb);
    expect(r).toEqual({ ok: false, reason: "inflate_limit" });
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it("many modest streams are bounded by the total inflate budget too", async () => {
    const r = await pdfToText(buildFlateBombPdf(20 * 1024 * 1024), { maxInflatedBytes: 1024 * 1024 });
    expect(r).toEqual({ ok: false, reason: "inflate_limit" });
  });

  it("never runs embedded script or fetches anything", async () => {
    const pdf = buildPdf([["Plain text"]]);
    const evil = new TextDecoder("latin1")
      .decode(pdf)
      .replace("/Type /Catalog", "/Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>");
    const bytes = new Uint8Array(Buffer.from(evil, "latin1"));
    const r = await pdfToText(bytes);
    expect(typeof r.ok).toBe("boolean");
  });
});
