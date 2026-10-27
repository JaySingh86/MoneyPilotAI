import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maskEmail, maskLast4 } from "./mask";

const BULLETS = "•••";

describe("maskLast4", () => {
  it("shows only the last 4 digits", () => {
    expect(maskLast4("4821")).toBe(`${BULLETS}4821`);
    expect(maskLast4("4111111111114821")).toBe(`${BULLETS}4821`);
    expect(maskLast4("4111 1111 1111 4821")).toBe(`${BULLETS}4821`);
  });

  it("uses U+2022 bullets", () => {
    expect([...maskLast4("4821").slice(0, 3)].every((c) => c.codePointAt(0) === 0x2022)).toBe(true);
  });

  it("rejects input with fewer than 4 digits", () => {
    expect(() => maskLast4("482")).toThrow(RangeError);
    expect(() => maskLast4("")).toThrow(RangeError);
  });
});

describe("maskEmail", () => {
  it("keeps the first 3 characters of the local part and the whole domain", () => {
    expect(maskEmail("samrivera@gmail.com")).toBe(`sam${BULLETS}@gmail.com`);
    expect(maskEmail("jordan.rivera@outlook.com")).toBe(`jor${BULLETS}@outlook.com`);
  });

  it("shows at most 3 characters of the name and always hides at least one", () => {
    expect(maskEmail("samantha@gmail.com")).toBe(`sam${BULLETS}@gmail.com`);
    expect(maskEmail("sami@x.com")).toBe(`sam${BULLETS}@x.com`);
    expect(maskEmail("sam@x.com")).toBe(`sa${BULLETS}@x.com`);
    expect(maskEmail("jo@x.com")).toBe(`j${BULLETS}@x.com`);
    expect(maskEmail("x@x.com")).toBe(`${BULLETS}@x.com`);
  });

  it("matches the fixture's masked address for Sam", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../design/fixtures/rivera-household.json", import.meta.url), "utf8"),
    ) as { members: { emailConnection: { maskedAddress: string } | null }[] };
    const masked = fixture.members[0]?.emailConnection?.maskedAddress;
    expect(maskEmail("sam.rivera@gmail.com")).toBe(masked);
  });

  it("splits on the last @", () => {
    expect(maskEmail('"a@b"@example.com')).toBe(`"a@${BULLETS}@example.com`);
  });

  it("rejects strings that are not an address", () => {
    expect(() => maskEmail("no-at-sign")).toThrow(TypeError);
    expect(() => maskEmail("@gmail.com")).toThrow(TypeError);
    expect(() => maskEmail("sam@")).toThrow(TypeError);
  });
});
