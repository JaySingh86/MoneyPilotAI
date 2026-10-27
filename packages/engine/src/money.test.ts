import { EngineError } from "./errors";
import {
  assertCents,
  ceilToWholeDollars,
  divRoundHalfUp,
  floorToMultiple,
  floorToWholeDollars,
} from "./money";

describe("assertCents", () => {
  it("accepts safe integers, including negatives", () => {
    expect(assertCents(0, "x")).toBe(0);
    expect(assertCents(-79299, "x")).toBe(-79299);
    expect(assertCents(Number.MAX_SAFE_INTEGER, "x")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects floats, NaN, infinities and unsafe integers", () => {
    for (const bad of [1.5, 0.1 + 0.2, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => assertCents(bad, "x")).toThrow(EngineError);
    }
  });
});

describe("floorToWholeDollars (rule 4 display)", () => {
  it("floors positive amounts", () => {
    expect(floorToWholeDollars(100701)).toBe(100700);
    expect(floorToWholeDollars(100799)).toBe(100700);
    expect(floorToWholeDollars(100700)).toBe(100700);
    expect(floorToWholeDollars(0)).toBe(0);
    expect(floorToWholeDollars(99)).toBe(0);
  });

  it("floors negative amounts toward −∞", () => {
    expect(floorToWholeDollars(-1)).toBe(-100);
    expect(floorToWholeDollars(-100)).toBe(-100);
  });
});

describe("ceilToWholeDollars (shortfall display)", () => {
  it("rounds up: $792.99 → $793", () => {
    expect(ceilToWholeDollars(79299)).toBe(79300);
    expect(ceilToWholeDollars(79300)).toBe(79300);
    expect(ceilToWholeDollars(79201)).toBe(79300);
    expect(ceilToWholeDollars(1)).toBe(100);
    expect(ceilToWholeDollars(0)).toBe(0);
  });
});

describe("floorToMultiple (rule 5)", () => {
  it("floors to the nearest $5", () => {
    expect(floorToMultiple(10070, 500)).toBe(10000);
    expect(floorToMultiple(10499, 500)).toBe(10000);
    expect(floorToMultiple(10500, 500)).toBe(10500);
    expect(floorToMultiple(499, 500)).toBe(0);
  });
});

describe("divRoundHalfUp", () => {
  it("divides integers and rounds half up", () => {
    expect(divRoundHalfUp(42600, 3)).toBe(14200);
    expect(divRoundHalfUp(10, 3)).toBe(3);
    expect(divRoundHalfUp(11, 3)).toBe(4);
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-2);
  });

  it("rejects a non-positive divisor", () => {
    expect(() => divRoundHalfUp(1, 0)).toThrow(EngineError);
  });
});
