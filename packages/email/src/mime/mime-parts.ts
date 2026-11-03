// Cheap pre-parse guard: refuse messages with an absurd number of MIME parts before any parser sees them
// (BACKEND_PLAN §7.8.2 parsing sandbox, Q-067). Counts boundary lines and Content-Type headers with one
// linear scan; no MIME parsing.

export const MAX_MIME_PARTS = 200;

/** Opening boundary lines: `--token` that does not end in `--` (those close a multipart). `-- ` is a signature. */
const BOUNDARY = /^--[^\s-][^\s]*[^\S\n]*$/gm;
const CONTENT_TYPE = /^content-type:/gim;

export function countMimeParts(bytes: Uint8Array): number {
  const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  let boundaries = 0;
  for (const m of s.matchAll(BOUNDARY)) {
    if (!m[0].trimEnd().endsWith("--")) boundaries++;
  }
  let types = 0;
  for (const _ of s.matchAll(CONTENT_TYPE)) types++;
  return Math.max(boundaries, types);
}
