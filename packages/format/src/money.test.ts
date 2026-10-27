import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimateRange, money, shortfall } from "./money";

const MINUS = "−";

interface ShortfallOption {
  safeToSpendCents: number;
  display: string;
}
interface Fixture {
  expected: { safeToSpendCents: number; safeToSpendDisplay: string; lowest: { balanceCents: number } };
  scenarios: {
    shortfall: {
      expected: {
        safeToSpendCents: number;
        heroDisplay: string;
        lowest: { balanceCents: number };
        options: ShortfallOption[];
      };
    };
  };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../design/fixtures/rivera-household.json", import.meta.url), "utf8"),
) as Fixture;

describe("money: detail", () => {
  it.each([
    [0, "$0.00"],
    [1, "$0.01"],
    [99, "$0.99"],
    [100, "$1.00"],
    [299, "$2.99"],
    [100000, "$1,000.00"],
    [559094, "$5,590.94"],
    [123456789, "$1,234,567.89"],
  ])("%i cents", (cents, expected) => {
    expect(money(cents, { mode: "detail" })).toBe(expected);
  });

  it("defaults to detail", () => {
    expect(money(215000)).toBe("$2,150.00");
  });

  it("marks a negative amount with U+2212, never a hyphen", () => {
    expect(money(-29299, { mode: "detail" })).toBe(`${MINUS}$292.99`);
  });
});

describe("money: headline (whole dollars, floored per DESIGN_SPEC §6 rule 4)", () => {
  it.each([
    [0, "$0"],
    [99, "$0"],
    [100701, "$1,007"],
    [50701, "$507"],
    [10701, "$107"],
    [920000, "$9,200"],
  ])("%i cents", (cents, expected) => {
    expect(money(cents, { mode: "headline" })).toBe(expected);
  });

  it("floors negatives toward −∞, matching the fixture breakdown (−$293, −$793)", () => {
    expect(money(-29299, { mode: "headline" })).toBe(`${MINUS}$293`);
    expect(money(-79299, { mode: "headline" })).toBe(`${MINUS}$793`);
    expect(money(-1, { mode: "headline" })).toBe(`${MINUS}$1`);
  });

  it("matches the fixture safe-to-spend display", () => {
    expect(money(fixture.expected.safeToSpendCents, { mode: "headline" })).toBe(
      fixture.expected.safeToSpendDisplay,
    );
  });

  it("matches the shortfall options that end above zero", () => {
    for (const opt of fixture.scenarios.shortfall.expected.options) {
      if (opt.safeToSpendCents >= 0) {
        expect(`${money(opt.safeToSpendCents, { mode: "headline" })} safe to spend`).toBe(opt.display);
      }
    }
  });
});

describe("money: headline rounding option (DESIGN_SPEC §7)", () => {
  it("defaults to floor (money you can spend rounds down)", () => {
    expect(money(56599, { mode: "headline" })).toBe("$565");
    expect(money(56599, { mode: "headline", rounding: "floor" })).toBe("$565");
  });

  it.each([
    [56560, "$566"],
    [56549, "$565"],
    [56550, "$566"],
    [49, "$0"],
    [50, "$1"],
    [-29249, `${MINUS}$292`],
    [-29250, `${MINUS}$293`],
    [-49, "$0"],
  ])("nearest (summaries and averages, half away from zero): %i cents", (cents, expected) => {
    expect(money(cents, { mode: "headline", rounding: "nearest" })).toBe(expected);
  });
});

describe("money: chip (calendar chips and per-year changes)", () => {
  it.each([
    [315000, "+$3,150"],
    [-126299, `${MINUS}$1,263`],
    [-126249, `${MINUS}$1,262`],
    [10000, "+$100"],
    [-10049, `${MINUS}$100`],
    [-2299, `${MINUS}$22.99`],
    [9999, "+$99.99"],
    [5500, "+$55"],
    [-800, `${MINUS}$8`],
    [1, "+$0.01"],
    [0, "$0"],
  ])("%i cents", (cents, expected) => {
    expect(money(cents, { mode: "chip" })).toBe(expected);
  });
});

describe("money: signed", () => {
  it("income gets +, outflow gets U+2212, zero gets no sign", () => {
    expect(money(290000, { mode: "signed" })).toBe("+$2,900.00");
    expect(money(-559094, { mode: "signed" })).toBe(`${MINUS}$5,590.94`);
    expect(money(0, { mode: "signed" })).toBe("$0.00");
  });
});

describe("money: estimate", () => {
  it("prefixes ~ and keeps cents", () => {
    expect(money(14200, { mode: "estimate" })).toBe("~$142.00");
    expect(money(15137, { mode: "estimate" })).toBe("~$151.37");
  });

  it("puts the sign after the ~ for negatives", () => {
    expect(money(-14200, { mode: "estimate" })).toBe(`~${MINUS}$142.00`);
  });
});

describe("money: input validation (hard rule 1: integer cents only)", () => {
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects %s", (bad) => {
    expect(() => money(bad, { mode: "detail" })).toThrow(TypeError);
  });

  it("formats the largest safe integer exactly", () => {
    expect(money(Number.MAX_SAFE_INTEGER, { mode: "detail" })).toBe("$90,071,992,547,409.91");
  });
});

describe("shortfall (rounded up to whole dollars, DESIGN_SPEC §6 rule 4)", () => {
  it("−$792.99 → $793 short", () => {
    expect(shortfall(-79299)).toBe("$793 short");
  });

  it("accepts the positive gap amount too", () => {
    expect(shortfall(79299)).toBe("$793 short");
  });

  it("rounds up partial dollars and leaves whole dollars alone", () => {
    expect(shortfall(-1)).toBe("$1 short");
    expect(shortfall(-10000)).toBe("$100 short");
    expect(shortfall(-10001)).toBe("$101 short");
    expect(shortfall(-123456789)).toBe("$1,234,568 short");
  });

  it("matches the fixture shortfall hero and options", () => {
    const s = fixture.scenarios.shortfall.expected;
    expect(shortfall(s.safeToSpendCents)).toBe(s.heroDisplay);
    for (const opt of s.options) {
      if (opt.safeToSpendCents < 0) {
        expect(opt.display.startsWith(`${shortfall(opt.safeToSpendCents)},`)).toBe(true);
      }
    }
  });

  it("rejects a zero shortfall and non-integers", () => {
    expect(() => shortfall(0)).toThrow(RangeError);
    expect(() => shortfall(0.5)).toThrow(TypeError);
  });
});

describe("estimateRange", () => {
  it("shows whole dollars (engine rounds ranges to $10)", () => {
    expect(estimateRange(3000)).toBe("±$30");
    expect(estimateRange(100000)).toBe("±$1,000");
  });

  it("keeps cents when the range is not whole dollars", () => {
    expect(estimateRange(3050)).toBe("±$30.50");
  });

  it("adds the chip label on request", () => {
    expect(estimateRange(3000, { label: true })).toBe("Estimate ±$30");
  });

  it("rejects negative ranges", () => {
    expect(() => estimateRange(-3000)).toThrow(RangeError);
  });
});
