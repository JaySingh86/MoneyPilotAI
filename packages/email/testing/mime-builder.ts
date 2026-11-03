// Builds synthetic RFC 822 messages for tests. Fictional companies and people only (CLAUDE.md: no real data).

export interface TestAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface TestEmail {
  from: string;
  to?: string;
  subject: string;
  date?: string;
  text?: string;
  html?: string;
  attachments?: TestAttachment[];
  headers?: Record<string, string>;
}

const CRLF = "\r\n";

function base64Lines(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/(.{76})/g, "$1" + CRLF);
}

function qp(text: string): string {
  // Minimal quoted-printable encoder (UTF-8) with soft line breaks.
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  let line = "";
  for (const b of bytes) {
    let piece: string;
    if (b === 0x0a) {
      out += line + CRLF;
      line = "";
      continue;
    } else if (b === 0x0d) {
      continue;
    } else if ((b >= 33 && b <= 126 && b !== 61) || b === 32) {
      piece = String.fromCharCode(b);
    } else {
      piece = "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    if (line.length + piece.length > 75) {
      out += line + "=" + CRLF;
      line = "";
    }
    line += piece;
  }
  return out + line;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function buildEmail(e: TestEmail): string {
  const headers: string[] = [
    `From: ${e.from}`,
    `To: ${e.to ?? "rivera-test@example.test"}`,
    `Subject: ${e.subject}`,
    `Date: ${e.date ?? "Tue, 27 Oct 2026 08:00:00 +0000"}`,
    `Message-ID: <${Math.abs(hash(e.subject + e.from))}@mail.example.test>`,
    "MIME-Version: 1.0",
    ...Object.entries(e.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  const atts = e.attachments ?? [];
  const bodyParts: { headers: string[]; body: string }[] = [];
  if (e.text !== undefined) {
    bodyParts.push({
      headers: ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: quoted-printable"],
      body: qp(e.text),
    });
  }
  if (e.html !== undefined) {
    bodyParts.push({
      headers: ['Content-Type: text/html; charset="utf-8"', "Content-Transfer-Encoding: quoted-printable"],
      body: qp(e.html),
    });
  }
  const alt = (): { headers: string[]; body: string } => {
    if (bodyParts.length === 1) return bodyParts[0]!;
    const b = "ALT_BOUNDARY_7f3a";
    return {
      headers: [`Content-Type: multipart/alternative; boundary="${b}"`],
      body:
        bodyParts.map((p) => `--${b}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`).join("") +
        `--${b}--`,
    };
  };
  if (bodyParts.length === 0 && atts.length === 0) {
    bodyParts.push({ headers: ["Content-Type: text/plain"], body: "" });
  }
  if (atts.length === 0) {
    const p = alt();
    return [...headers, ...p.headers].join(CRLF) + CRLF + CRLF + p.body + CRLF;
  }
  const mb = "MIXED_BOUNDARY_91c2";
  const main = bodyParts.length ? alt() : null;
  let body = "";
  if (main) body += `--${mb}${CRLF}${main.headers.join(CRLF)}${CRLF}${CRLF}${main.body}${CRLF}`;
  for (const a of atts) {
    body +=
      `--${mb}${CRLF}Content-Type: ${a.contentType}; name="${a.filename}"${CRLF}` +
      `Content-Disposition: attachment; filename="${a.filename}"${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Lines(a.content)}${CRLF}`;
  }
  body += `--${mb}--`;
  return (
    [...headers, `Content-Type: multipart/mixed; boundary="${mb}"`].join(CRLF) + CRLF + CRLF + body + CRLF
  );
}

/** A message whose multipart parts are nested `depth` levels deep (nesting bomb). */
export function buildNestedMultipart(depth: number, leafText = "Amount due $10.00"): string {
  let body = `Content-Type: text/plain${CRLF}${CRLF}${leafText}${CRLF}`;
  for (let i = depth; i >= 1; i--) {
    const b = `B${i}`;
    body = `Content-Type: multipart/mixed; boundary="${b}"${CRLF}${CRLF}--${b}${CRLF}${body}${CRLF}--${b}--${CRLF}`;
  }
  return `From: billing@nested.example.test${CRLF}Subject: nested${CRLF}MIME-Version: 1.0${CRLF}${body}`;
}
