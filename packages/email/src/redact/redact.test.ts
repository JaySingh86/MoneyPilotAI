import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

const r = (s: string, senderDomain = "lakeside-auto.example") => redact(s, { senderDomain }).text;

describe("redact: keeps what extraction needs", () => {
  it.each([
    "Amount due: $684.00",
    "Total $1,234.56 due 2026-11-04",
    "Pay by 11/04/2026 or November 4, 2026",
    "Previous balance 12345678.90 and new balance $12,345,678.90",
    "Renews on 2027-01-09 for $168.00 per year",
    "Statement closing date 2026-10-15",
    "Invoice total $9999999999.99",
  ])("leaves amounts and dates alone: %s", (s) => {
    expect(r(s)).toBe(s);
  });

  it("keeps the sender domain's own addresses, masks everyone else's", () => {
    const out = r(
      "Write billing@lakeside-auto.example or jordan.rivera@gmail.test or x@mail.lakeside-auto.example",
    );
    expect(out).toContain("billing@lakeside-auto.example");
    expect(out).toContain("x@mail.lakeside-auto.example");
    expect(out).not.toContain("jordan.rivera");
    expect(out).toContain("[email]");
  });

  it("does not treat lookalike domains as the sender domain", () => {
    const out = r("a@lakeside-auto.example.evil.test b@notlakeside-auto.example");
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("notlakeside");
  });
});

describe("redact: account and policy numbers reduced to the last 4", () => {
  it("masks long digit runs and keeps the last 4", () => {
    const out = r("Account number 123456789012 is overdue");
    expect(out).not.toContain("123456789012");
    expect(out).not.toMatch(/\d{5,}/);
    expect(out).toContain("9012");
  });

  it("handles separators in account numbers", () => {
    expect(r("Acct 1234-5678-9012")).not.toMatch(/1234-5678|5678/);
    expect(r("Acct 1234-5678-9012")).toContain("9012");
    expect(r("Acct 1234 5678 9012")).not.toContain("5678");
  });

  it("masks keyworded alphanumeric policy numbers", () => {
    const out = r("Policy number: ABC-123456789 effective 2026-11-04");
    expect(out).not.toContain("123456789");
    expect(out).toContain("6789");
    expect(out).toContain("2026-11-04");
  });

  it("masks member, subscriber and loan ids", () => {
    for (const s of ["Member ID: W123456789", "Subscriber # XJ99887766", "Loan no. 00112233445"]) {
      const out = r(s);
      expect(out).not.toMatch(/\d{5,}/);
    }
  });

  it("already-short identifiers stay (last 4 only is the target form)", () => {
    expect(r("Policy ending in 4821")).toBe("Policy ending in 4821");
    expect(r("Account ****4821")).toBe("Account ****4821");
  });
});

describe("redact: card numbers, SSNs, phones", () => {
  it("masks Luhn-valid card numbers with any separators", () => {
    for (const card of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "378282246310005",
    ]) {
      const out = r(`Charged to card ${card} today`);
      expect(out).not.toContain(card);
      expect(out).not.toMatch(/\d{5,}/);
      expect(out).toContain(card.slice(-4));
    }
  });

  it("masks SSNs fully (no last 4)", () => {
    for (const s of ["SSN 123-45-6789", "ssn: 123 45 6789", "Social Security Number 123456789"]) {
      const out = r(s);
      expect(out).not.toMatch(/6789/);
      expect(out).toContain("[ssn]");
    }
  });

  it("masks US phone numbers in common formats", () => {
    for (const p of ["(555) 123-4567", "555-123-4567", "555.123.4567", "+1 555 123 4567", "1-800-555-0199"]) {
      const out = r(`Call ${p} for help`);
      expect(out).toContain("[phone]");
      expect(out).not.toMatch(/555/);
    }
  });

  it("does not mistake amounts for phone numbers", () => {
    expect(r("Total $555.123")).toBe("Total $555.123");
    expect(r("Due $1,555.00")).toBe("Due $1,555.00");
  });
});

describe("redact: adversarial inputs", () => {
  it("is not fooled by zero-width characters between digits", () => {
    const out = r("Account 1234\u200B5678\u200B9012");
    expect(out).not.toContain("5678");
  });

  it("handles huge inputs in linear-ish time (ReDoS guard)", () => {
    const evil = "1 ".repeat(50_000) + "a".repeat(100_000) + "-".repeat(50_000) + "@".repeat(20_000);
    const t = performance.now();
    redact(evil, { senderDomain: "x.example" });
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it("returns counts of what it masked, for logging without content", () => {
    const res = redact(
      "SSN 123-45-6789 card 4111 1111 1111 1111 call 555-123-4567 a@b.test acct 123456789012",
      {
        senderDomain: "x.example",
      },
    );
    expect(res.counts).toEqual({ ssn: 1, card: 1, phone: 1, email: 1, account: 1 });
  });
});

describe("redact: properties", () => {
  const digit = fc.integer({ min: 0, max: 9 }).map(String);

  it("a long digit run never survives beyond its last 4", () => {
    fc.assert(
      fc.property(
        fc.array(digit, { minLength: 8, maxLength: 24 }),
        fc.stringMatching(/^[a-z ]{0,12}$/),
        (ds, pre) => {
          const num = ds.join("");
          const out = r(`${pre} number ${num} end`);
          // no run of 5+ digits remains
          expect(out).not.toMatch(/\d{5,}/);
          // and the original run is gone unless it is itself already a valid short form
          expect(out.includes(num)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the last 4 digits of a long account number are preserved", () => {
    fc.assert(
      fc.property(fc.array(digit, { minLength: 9, maxLength: 20 }), (ds) => {
        const num = ds.join("");
        const out = r(`Account ${num}`);
        expect(out).toContain(num.slice(-4));
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const once = r(s);
        expect(r(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it("any SSN-shaped value is gone", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 100, max: 899 }),
          fc.integer({ min: 10, max: 99 }),
          fc.integer({ min: 1000, max: 9999 }),
        ),
        fc.constantFrom("-", " "),
        ([a, b, c], sep) => {
          const out = r(`SSN ${a}${sep}${b}${sep}${c}`);
          expect(out).not.toContain(String(c));
          expect(out).toContain("[ssn]");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("phone-shaped values are gone, and amounts and ISO dates are untouched", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 999 }),
        fc.integer({ min: 200, max: 999 }),
        fc.integer({ min: 0, max: 9999 }),
        (a, b, c) => {
          const phone = `(${a}) ${b}-${String(c).padStart(4, "0")}`;
          expect(r(`Call ${phone}`)).toBe("Call [phone]");
        },
      ),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999_99 }),
        fc.integer({ min: 2020, max: 2035 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (cents, y, m, d) => {
          const dollars = Math.floor(cents / 100);
          const amount = `$${dollars.toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
          const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const s = `Amount due ${amount} on ${date}`;
          expect(r(s)).toBe(s);
        },
      ),
      { numRuns: 300 },
    );
  });
});
