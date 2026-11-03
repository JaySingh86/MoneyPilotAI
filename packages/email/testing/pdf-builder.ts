// Builds tiny synthetic PDFs (Helvetica text only) for tests. No real documents.
import { deflateSync } from "node:zlib";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export interface BuildPdfOptions {
  /** Deflate content streams. */
  compress?: boolean;
  /** Extra raw bytes appended to every content stream (bomb tests). */
  extraStream?: Uint8Array;
}

/** One entry of `pages` is the list of text lines for that page. */
export function buildPdf(pages: string[][], opts: BuildPdfOptions = {}): Uint8Array {
  const objs: (Buffer | string)[] = [];
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs from 4.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const pageNo = 4 + i * 2;
    const contentNo = pageNo + 1;
    objs[pageNo] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNo} 0 R ` +
      `/Resources << /Font << /F1 3 0 R >> >> >>`;
    const ops = ["BT", "/F1 11 Tf", "14 TL", "72 720 Td"];
    for (const l of lines) ops.push(`(${esc(l)}) Tj T*`);
    ops.push("ET");
    let data: Buffer = Buffer.from(ops.join("\n"), "latin1");
    if (opts.extraStream) data = Buffer.concat([data, Buffer.from("\n"), Buffer.from(opts.extraStream)]);
    if (opts.compress) {
      const z = deflateSync(data);
      objs[contentNo] = Buffer.concat([
        Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`),
        z,
        Buffer.from("\nendstream"),
      ]);
    } else {
      objs[contentNo] = Buffer.concat([
        Buffer.from(`<< /Length ${data.length} >>\nstream\n`),
        data,
        Buffer.from("\nendstream"),
      ]);
    }
  });
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let pos = chunks[0]!.length;
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pos;
    const raw = objs[i]!;
    const body = typeof raw === "string" ? Buffer.from(raw, "latin1") : raw;
    const c = Buffer.concat([Buffer.from(`${i} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(c);
    pos += c.length;
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A small PDF whose single content stream inflates to about `inflatedBytes` of padding
 * (a deflate bomb: tiny on disk, large in memory).
 */
export function buildFlateBombPdf(inflatedBytes: number): Uint8Array {
  const pad = Buffer.alloc(inflatedBytes, 0x20);
  return buildPdf([["Amount due: $50.00"]], { compress: true, extraStream: pad });
}
