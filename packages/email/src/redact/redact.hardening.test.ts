// Regression tests for the security review (H1 ReDoS, M1 redaction bypasses).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

const r = (s: string, senderDomain = "lakeside-auto.example") => redact(s, { senderDomain }).text;

function timed<T>(fn: () => T): { out: T; ms: number } {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
}

describe("H1: no super-linear behavior on whitespace and long runs", () => {
  const BUDGET_MS = 1500;
  const floods: [string, string][] = [
    ["U+1680", " "],
    ["U+2028", " "],
    ["U+2029", " "],
    ["NBSP", " "],
    ["space", " "],
    ["tab", "\t"],
  ];
  it.each(floods)("keyword followed by a %s flood stays inside the runtime budget", (_n, ch) => {
    const text = "Policy" + ch.repeat(150_000) + "x";
    const { ms } = timed(() => r(text));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each(floods)("many keywords each followed by a %s run stay inside the budget", (_n, ch) => {
    const text = ("account" + ch.repeat(50)).repeat(3000) + "\n";
    const { ms } = timed(() => r(text));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("150k-character runs of digits, letters, dashes, dots and newlines are fast", () => {
    for (const unit of ["1", "a", "-", ".", "\n", "1 ", "12.", "@", "1-", "a@"]) {
      const text = unit.repeat(Math.ceil(150_000 / unit.length));
      const { ms } = timed(() => r(text));
      expect(ms, `unit ${JSON.stringify(unit)}`).toBeLessThan(BUDGET_MS);
    }
  });

  it("keyword + 150k alphanumerics is fast", () => {
    const { ms } = timed(() => r("Policy: " + "A1".repeat(75_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("odd Unicode whitespace is treated as a space and does not hide a keyworded id", () => {
    const out = r("Policy number ABC-123456789");
    expect(out).not.toContain("123456789");
  });
});

describe("M1: card, SSN, keyword, newline, email, digit and phone bypasses", () => {
  it("dotted card groups", () => {
    const out = r("Card 4111.1111.1111.1111 on file");
    expect(out).not.toContain("4111.1111");
    expect(out).toContain("[card ••••1111]");
  });

  it.each(["Name,123-45-6789", "ID-123-45-6789", "123.45.6789", "(123-45-6789)", "SSN:123-45-6789"])(
    "SSN %s is masked",
    (s) => {
      const out = r(s);
      expect(out).toContain("[ssn]");
      expect(out).not.toContain("6789");
    },
  );

  it.each([
    "Policy (Auto): 1234567",
    "policy number is ABCD1234EF",
    "Your account, number: 99887766",
    "Member - ID # W123456789",
    "Subscriber (primary) XJ99887766",
  ])("keyword with filler: %s", (s) => {
    const out = r(s);
    expect(out).not.toMatch(/\d{5,}/);
    expect(out).toContain("[acct ••••");
  });

  it("filler does not swallow dates or amounts after a keyword", () => {
    expect(r("Policy renews 2026-11-04 for $684.00")).toBe("Policy renews 2026-11-04 for $684.00");
    expect(r("Account balance $12345678.90")).toBe("Account balance $12345678.90");
  });

  it("joins digit groups across single newlines", () => {
    const out = r("Card number\n4111 1111\n1111 1111\nthanks");
    expect(out).not.toContain("4111 1111");
    expect(out).toContain("1111]");
    const acct = r("Account 1234\n5678\n9012");
    expect(acct).not.toContain("5678");
  });

  it("unicode local parts and obfuscated addresses", () => {
    expect(r("write josé.garcía@mailbox.example now")).toContain("[email]");
    expect(r("write josé.garcía@mailbox.example now")).not.toContain("garc");
    for (const s of [
      "bob [at] mailbox [dot] example",
      "bob(at)mailbox(dot)example",
      "bob [AT] mailbox [DOT] co [DOT] uk",
    ]) {
      const out = r(s);
      expect(out, s).toContain("[email]");
      expect(out, s).not.toMatch(/bob/i);
    }
  });

  it("folds non-Latin decimal digits before masking", () => {
    for (const digits of ["١٢٣٤٥٦٧٨٩٠١٢", "१२३४५६७८९०१२", "１２３４５６７８９０１２"]) {
      const out = r(`Account number ${digits}`);
      expect(out).toContain("9012");
      expect(out).not.toMatch(/[\p{Nd}]{5,}/u);
    }
  });

  it.each([
    "+44 20 7946 0958",
    "+33 1 23 45 67 89",
    "+81-3-1234-5678",
    "+49 (30) 1234567",
    "+52 55 1234 5678",
  ])("international phone %s is fully masked", (p) => {
    const out = r(`Call ${p} today`);
    expect(out).toBe("Call [phone] today");
  });
});

describe("M1 properties: Luhn-valid cards survive no separator or character mutation", () => {
  function luhnComplete(prefix: string): string {
    for (let d = 0; d < 10; d++) {
      const n = prefix + d;
      let sum = 0;
      let dbl = false;
      for (let i = n.length - 1; i >= 0; i--) {
        let x = n.charCodeAt(i) - 48;
        if (dbl) {
          x *= 2;
          if (x > 9) x -= 9;
        }
        sum += x;
        dbl = !dbl;
      }
      if (sum % 10 === 0) return n;
    }
    throw new Error("unreachable");
  }
  const cardArb = fc
    .tuple(
      fc.constantFrom("4", "5", "37", "6011"),
      fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 15, maxLength: 15 }),
    )
    .map(([p, rest]) => luhnComplete(p + rest.slice(0, 15 - p.length).join("")));
  const SEPS = [" ", "-", ".", "\n", "  ", " - ", " ", " ", " "];
  const toFullwidth = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
  const toArabic = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));

  it("no 5+ digit run of the card survives, whatever the grouping, separators, zero-width chars or script", () => {
    fc.assert(
      fc.property(
        cardArb,
        fc.constantFrom(4, 16), // standard 4-4-4-4 grouping, or no grouping
        fc.constantFrom(...SEPS),
        fc.constantFrom("", "​", "⁠", "﻿"),
        fc.constantFrom("ascii", "fullwidth", "arabic"),
        (card, group, sep, zw, script) => {
          const groups = card.match(new RegExp(`.{1,${group}}`, "g"))!;
          let text = groups.map((g) => g.split("").join(zw)).join(sep);
          if (script === "fullwidth") text = toFullwidth(text);
          if (script === "arabic") text = toArabic(text);
          const out = r(`Charged to ${text} today`);
          expect(out.replace(/[^\d]/g, "").length).toBeLessThanOrEqual(4 + 0);
          expect(out).toContain(card.slice(-4));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("SSN separators and prefixes", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 100, max: 899 }),
          fc.integer({ min: 10, max: 99 }),
          fc.integer({ min: 1000, max: 9999 }),
        ),
        fc.constantFrom("-", " ", "."),
        fc.constantFrom("", "Name,", "ID-", "(", "#", "ssn:"),
        ([a, b, c], sep, pre) => {
          const out = r(`${pre}${a}${sep}${b}${sep}${c}`);
          expect(out).not.toContain(String(c));
        },
      ),
      { numRuns: 300 },
    );
  });
});
