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

  it("a crafted header cannot smuggle a dmarc=pass inside a comment or a quoted string (S1)", () => {
    const crafted =
      'mx.google.com; spf=fail (sender "x dmarc=pass"@evil.com is not allowed) smtp.mailfrom="x dmarc=pass"@evil.com; ' +
      "dkim=none; dmarc=fail (p=reject) header.from=bank.com";
    const r = parseAuthenticationResults(crafted, "bank.com");
    expect(r).toMatchObject({ spf: "fail", dkim: "none", dmarc: "fail", dmarcAligned: false });
    // The same payload with the real verdict missing must read as unknown, not pass.
    const onlyInjected =
      'mx.google.com; spf=fail smtp.mailfrom="x dmarc=pass"@evil.com (dmarc=pass header.from=bank.com)';
    const r2 = parseAuthenticationResults(onlyInjected, "bank.com");
    expect(r2.dmarc).toBe("unknown");
    expect(r2.dmarcAligned).toBe(false);
  });

  it("a method name inside another segment's property is not read as a method", () => {
    const r = parseAuthenticationResults(
      "mx.google.com; dkim=fail header.d=dmarc=pass.example; dmarc=none header.from=x.example",
      "x.example",
    );
    expect(r).toMatchObject({ dkim: "fail", dmarc: "none", dmarcAligned: false });
  });

  it("DMARC pass without a header.from is not aligned (S1)", () => {
    const r = parseAuthenticationResults("mx.google.com; dmarc=pass", "x.example");
    expect(r.dmarc).toBe("pass");
    expect(r.dmarcAligned).toBe(false);
  });

  it("handles nested comments and escaped parentheses without reading through them", () => {
    const r = parseAuthenticationResults(
      "mx.google.com; dmarc=pass (outer (inner) more dmarc=fail \\) still comment) header.from=x.example",
      "x.example",
    );
    expect(r).toMatchObject({ dmarc: "pass", dmarcAligned: true });
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
  it("topmostOnly: a trusted-looking header further down (planted by the sender) is not the receiver's (S4)", () => {
    const planted = [
      { key: "authentication-results", value: "evil.example; dmarc=fail header.from=a.example" },
      { key: "authentication-results", value: "mx.moneypilot.test; dmarc=pass header.from=a.example" },
    ];
    expect(pickAuthenticationResults(planted, ["mx.moneypilot.test"])).toBe(planted[1]!.value);
    expect(pickAuthenticationResults(planted, ["mx.moneypilot.test"], { topmostOnly: true })).toBeNull();
    expect(pickAuthenticationResults(headers, ["mx.moneypilot.test"], { topmostOnly: true })).toBe(
      headers[0]!.value,
    );
  });
  it("requireTokens: the header must carry what only the receiving system writes (Exchange's compauth)", () => {
    const own =
      "spf=pass smtp.mailfrom=a.example; dmarc=pass action=none header.from=a.example;compauth=pass reason=100";
    const forged = "spf=pass smtp.mailfrom=a.example; dmarc=pass header.from=a.example";
    const opts = { topmostOnly: true, requireTokens: ["compauth="] };
    expect(pickAuthenticationResults([{ key: "Authentication-Results", value: own }], [], opts)).toBe(own);
    expect(
      pickAuthenticationResults([{ key: "Authentication-Results", value: forged }], [], opts),
    ).toBeNull();
    // A token hidden in a comment does not count.
    const hidden = "spf=pass; dmarc=pass header.from=a.example (compauth=pass)";
    expect(
      pickAuthenticationResults([{ key: "Authentication-Results", value: hidden }], [], opts),
    ).toBeNull();
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
