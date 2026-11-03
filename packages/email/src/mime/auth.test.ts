import { describe, expect, it } from "vitest";
import { countMimeParts, MAX_MIME_PARTS } from "./mime-parts.js";
import { parseAuthenticationResults, pickAuthenticationResults } from "./auth.js";
import { findOriginalSenderDomain } from "./forwarded.js";

describe("parseAuthenticationResults", () => {
  const hdr =
    "mx.moneypilot.test; dkim=pass header.d=billing.lakeside-auto.example; spf=pass smtp.mailfrom=x@billing.lakeside-auto.example; " +
    "dmarc=pass (p=reject) header.from=lakeside-auto.example";

  it("returns verdicts only, plus the authserv-id", () => {
    const r = parseAuthenticationResults(hdr, "billing.lakeside-auto.example");
    expect(r).toEqual({
      authservId: "mx.moneypilot.test",
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      dmarcAligned: true,
    });
    expect(JSON.stringify(r)).not.toContain("smtp.mailfrom");
  });

  it("DMARC pass for a different header.from is not aligned", () => {
    const r = parseAuthenticationResults(
      "mx.moneypilot.test; dmarc=pass header.from=evil.example",
      "lakeside-auto.example",
    );
    expect(r.dmarc).toBe("pass");
    expect(r.dmarcAligned).toBe(false);
  });

  it("maps failures and unknowns", () => {
    const r = parseAuthenticationResults(
      "mx.moneypilot.test; spf=softfail; dkim=none; dmarc=fail header.from=x.example",
      "x.example",
    );
    expect(r).toMatchObject({ spf: "fail", dkim: "none", dmarc: "fail", dmarcAligned: false });
  });

  it("no sender domain means never aligned", () => {
    expect(parseAuthenticationResults("mx.a.test; dmarc=pass", null).dmarcAligned).toBe(false);
  });

  it("garbage yields unknown", () => {
    expect(parseAuthenticationResults("", "x.example")).toMatchObject({
      dmarc: "unknown",
      dmarcAligned: false,
    });
    expect(parseAuthenticationResults("x".repeat(100_000), "x.example").dmarc).toBe("unknown");
  });
});

describe("pickAuthenticationResults", () => {
  const headers = [
    { key: "authentication-results", value: "mx.moneypilot.test; dmarc=pass header.from=a.example" },
    { key: "authentication-results", value: "forged.example; dmarc=pass header.from=a.example" },
  ];
  it("without a trusted list it takes the first (top-most) header", () => {
    expect(pickAuthenticationResults(headers, [])).toBe(headers[0]!.value);
  });
  it("with a trusted list only an authserv-id on the list counts, first match wins", () => {
    expect(pickAuthenticationResults(headers, ["mx.moneypilot.test"])).toBe(headers[0]!.value);
    expect(pickAuthenticationResults(headers, ["other.test"])).toBeNull();
    expect(pickAuthenticationResults([headers[1]!], ["mx.moneypilot.test"])).toBeNull();
  });
  it("none present", () => {
    expect(pickAuthenticationResults([], [])).toBeNull();
  });
});

describe("countMimeParts", () => {
  const part = (i: number) => `--B\r\nContent-Type: text/plain\r\n\r\nbody ${i}\r\n`;
  it("counts opening boundaries and not closing ones or signature dashes", () => {
    const raw = "Subject: x\r\n\r\n" + [1, 2, 3].map(part).join("") + "--B--\r\n-- \r\nSig\r\n";
    expect(countMimeParts(new TextEncoder().encode(raw))).toBe(3);
  });
  it("counts a Content-Type header flood too", () => {
    const raw = "Content-Type: text/plain\n".repeat(300);
    expect(countMimeParts(new TextEncoder().encode(raw))).toBeGreaterThan(MAX_MIME_PARTS);
  });
  it("is fast on 10 MB of boundary-looking lines", () => {
    const raw = new TextEncoder().encode("--x\n".repeat(2_500_000));
    const t = performance.now();
    countMimeParts(raw);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("findOriginalSenderDomain", () => {
  it("reads the From line of a forwarded-message block", () => {
    const body =
      "FYI\n\n---------- Forwarded message ---------\nFrom: Lakeside Auto <renewals@billing.lakeside-auto.example>\nDate: Mon\nSubject: Renewal\n";
    expect(findOriginalSenderDomain(body, [])).toEqual({
      domain: "billing.lakeside-auto.example",
      source: "forward_block",
    });
  });
  it("handles Begin forwarded message and Original Message styles", () => {
    expect(findOriginalSenderDomain("Begin forwarded message:\n\nFrom: x@a-corp.example\n", [])?.domain).toBe(
      "a-corp.example",
    );
    expect(
      findOriginalSenderDomain('-----Original Message-----\nFrom: "Q" <q@b-corp.example>\n', [])?.domain,
    ).toBe("b-corp.example");
  });
  it("falls back to Resent-From and X-Original-Sender style headers", () => {
    expect(
      findOriginalSenderDomain("hello", [{ key: "resent-from", value: "Bill <b@c-corp.example>" }]),
    ).toEqual({
      domain: "c-corp.example",
      source: "header",
    });
  });
  it("returns null when nothing is found and ignores junk", () => {
    expect(findOriginalSenderDomain("just a note", [])).toBeNull();
    expect(findOriginalSenderDomain("Forwarded message\nFrom: not an address\n", [])).toBeNull();
  });
  it("is bounded on hostile input", () => {
    const t = performance.now();
    findOriginalSenderDomain("Forwarded message".repeat(20_000) + "\n".repeat(100_000), []);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
