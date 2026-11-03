import { describe, expect, it } from "vitest";
import { CORPUS } from "../../testing/corpus-emails.js";
import { buildEmail } from "../../testing/mime-builder.js";
import { buildFlateBombPdf } from "../../testing/pdf-builder.js";
import { MAX_MIME_PARTS } from "./mime-parts.js";
import { prepareEmailInProcess } from "./prepare.js";
import { prepareEmail } from "./sandbox.js";

const url = (f: string) => new URL(`../../testing/${f}`, import.meta.url);
const simple = buildEmail({
  from: "Bill <billing@x-corp.example>",
  subject: "Statement",
  text: "Amount due $5.00 on 2026-11-01.",
});

describe("sandboxed prepareEmail", () => {
  it("returns exactly what the in-process path returns", async () => {
    const c = CORPUS[0]!;
    const raw = buildEmail(c.email);
    const sandboxed = await prepareEmail(raw);
    const direct = await prepareEmailInProcess(raw);
    expect(sandboxed).toEqual(direct);
    expect(sandboxed.ok).toBe(true);
  }, 60_000);

  it("refuses a MIME part-count bomb before spawning anything", async () => {
    const part = "--B\r\nContent-Type: text/plain\r\n\r\nx\r\n";
    const raw =
      "Content-Type: multipart/mixed; boundary=B\r\n\r\n" + part.repeat(MAX_MIME_PARTS + 50) + "--B--\r\n";
    const t = performance.now();
    expect(await prepareEmail(raw)).toEqual({ ok: false, reason: "parse_limit" });
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it("a PDF inflating far past the cap gives parse_limit and the parent survives", async () => {
    const raw = buildEmail({
      from: "a@x-corp.example",
      subject: "s",
      text: "Statement attached, amount due $5.00 soon.",
      attachments: [
        { filename: "s.pdf", contentType: "application/pdf", content: buildFlateBombPdf(300 * 1024 * 1024) },
      ],
    });
    expect(await prepareEmail(raw)).toEqual({ ok: false, reason: "parse_limit" });
    // the process is still healthy and the next message works
    const next = await prepareEmail(simple);
    expect(next.ok).toBe(true);
  }, 60_000);

  it("kills a CPU spin at the wall-clock timeout and returns parse_limit", async () => {
    const t = performance.now();
    const r = await prepareEmail(simple, { sandbox: { entry: url("spin-worker.ts"), timeoutMs: 1500 } });
    expect(r).toEqual({ ok: false, reason: "parse_limit" });
    expect(performance.now() - t).toBeLessThan(15_000);
    expect((await prepareEmail(simple)).ok).toBe(true);
  }, 60_000);

  it("a worker that exhausts its heap fails as parse_limit and the parent survives", async () => {
    const r = await prepareEmail(simple, {
      sandbox: { entry: url("oom-worker.ts"), timeoutMs: 30_000, maxOldGenerationSizeMb: 48 },
    });
    expect(r).toEqual({ ok: false, reason: "parse_limit" });
    expect((await prepareEmail(simple)).ok).toBe(true);
  }, 90_000);

  it("a worker that crashes on load does not hang or throw", async () => {
    const r = await prepareEmail(simple, { sandbox: { entry: url("crash-worker.ts"), timeoutMs: 20_000 } });
    expect(r.ok).toBe(false);
  }, 60_000);

  it("still enforces the raw size cap in the parent", async () => {
    expect(await prepareEmail(new Uint8Array(11 * 1024 * 1024))).toEqual({ ok: false, reason: "too_large" });
  });
});
