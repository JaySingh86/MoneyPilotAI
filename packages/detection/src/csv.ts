// CSV bytes to rows (BACKEND_PLAN §7.7 step 2). Pure: bytes in, rows out. The file is untrusted, so every limit
// is enforced here and a violation is a typed error the worker maps to an `imports.error` code.
import Papa from "papaparse";

export const MAX_CSV_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_ROWS = 50_000;
export const MAX_CSV_COLUMNS = 100;
export const MAX_CELL_CHARS = 2_000;
export const MAX_HEADER_CHARS = 100;

export type CsvErrorCode =
  "too_large" | "empty" | "no_rows" | "too_many_rows" | "too_many_columns" | "bad_encoding" | "parse_failed";

export class CsvError extends Error {
  override readonly name = "CsvError";
  constructor(readonly code: CsvErrorCode) {
    super(code);
  }
}

export interface ParsedCsv {
  delimiter: string;
  /** Trimmed, unique, non-empty header names (an empty or repeated header gets a `column N` / `name (2)` name). */
  headers: string[];
  /** One record per data row, keyed by header. Cells are trimmed and capped. */
  rows: Record<string, string>[];
}

/** UTF-8 (with or without BOM) or UTF-16 with BOM; anything else that is not valid UTF-8 is read as Windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length > MAX_CSV_BYTES) throw new CsvError("too_large");
  if (bytes.length === 0) throw new CsvError("empty");
  const b0 = bytes[0];
  const b1 = bytes[1];
  try {
    if (b0 === 0xff && b1 === 0xfe)
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    if (b0 === 0xfe && b1 === 0xff)
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    // Not valid UTF-8 (UTF-16 failures land here too and stay errors below).
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) throw new CsvError("bad_encoding");
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      throw new CsvError("bad_encoding");
    }
  }
}

function uniqueHeaders(raw: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim().replace(/\s+/g, " ").slice(0, MAX_HEADER_CHARS) || `column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text, {
    delimitersToGuess: [",", ";", "\t", "|"],
    skipEmptyLines: "greedy",
    header: false,
  });
  // Papa reports ragged rows as errors; a bank file with a trailing note line is still usable, so only a parse
  // that produced nothing is fatal.
  const all = result.data;
  if (all.length === 0) throw new CsvError("empty");
  const headerRow = all[0] ?? [];
  if (headerRow.length > MAX_CSV_COLUMNS) throw new CsvError("too_many_columns");
  if (all.length - 1 > MAX_CSV_ROWS) throw new CsvError("too_many_rows");
  if (all.length < 2) throw new CsvError("no_rows");
  const headers = uniqueHeaders(headerRow);
  const rows = all.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = (cells[i] ?? "").trim().slice(0, MAX_CELL_CHARS);
    });
    return record;
  });
  return { delimiter: result.meta.delimiter, headers, rows };
}
