// @vitest-environment node
// Proves the repo stylelint config fires (WP-10: no hex or raw px outside token files).
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

const configFile = fileURLToPath(new URL("../../../../../stylelint.config.mjs", import.meta.url));

async function problems(code: string): Promise<string[]> {
  const result = await stylelint.lint({ code, configFile });
  return (result.results[0]?.warnings ?? []).map((w) => w.rule);
}

const UNIT = "declaration-property-unit-disallowed-list";
const VALUE = "declaration-property-value-allowed-list";

describe("stylelint token rules", () => {
  it("rejects hex, named and functional colors", async () => {
    // eslint-disable-next-line no-restricted-syntax -- a deliberate violation proving the CSS rule fires
    expect(await problems(".a { color: #1F4E79; }")).toContain("color-no-hex");
    expect(await problems(".a { color: red; }")).toContain("color-named");
    expect(await problems(".a { background: rgb(0 0 0); }")).toContain("function-disallowed-list");
  });

  it("rejects raw px for type, spacing, radius and shadow", async () => {
    for (const decl of [
      "font-size: 14px",
      "font: 600 13px/19px Inter",
      "line-height: 20px",
      "padding: 12px",
      "margin-top: 4px",
      "gap: 8px",
      "border-radius: 10px",
      "box-shadow: 0 1px 2px var(--mp-text-primary)",
    ]) {
      expect(await problems(`.a { ${decl}; }`), decl).toContain(UNIT);
    }
  });

  it("rejects px offsets on top, right, bottom, left and inset, but allows percentages and tokens", async () => {
    for (const prop of ["top", "right", "bottom", "left", "inset"]) {
      expect(await problems(`.a { ${prop}: 4px; }`), prop).toContain(UNIT);
    }
    expect(await problems(".a { top: 50%; left: var(--mp-space-2); inset: 0; }")).toEqual([]);
  });

  it("rejects literal durations in transition and animation (use --mp-duration)", async () => {
    for (const decl of [
      "transition: color 150ms ease",
      "transition-duration: 0.2s",
      "transition-delay: 50ms",
      "animation: spin 1s linear",
      "animation-duration: 300ms",
    ]) {
      expect(await problems(`.a { ${decl}; }`), decl).toContain(UNIT);
    }
    expect(await problems(".a { transition: color var(--mp-duration) var(--mp-easing); }")).toEqual([]);
  });

  it("limits font-weight to 400, 500, 600, 700 and 800", async () => {
    for (const w of ["400", "500", "600", "700", "800"]) {
      expect(await problems(`.a { font-weight: ${w}; }`), w).toEqual([]);
    }
    for (const w of ["300", "900", "bold", "normal"]) {
      expect(await problems(`.a { font-weight: ${w}; }`), w).toContain(VALUE);
    }
  });

  it("requires font, font-size and line-height to come from tokens", async () => {
    expect(await problems(".a { font: var(--mp-type-small); }")).toEqual([]);
    expect(await problems(".a { font: inherit; }")).toEqual([]);
    expect(await problems(".a { font-size: var(--mp-type-size-small); line-height: var(--mp-lh); }")).toEqual(
      [],
    );
    expect(await problems(".a { font: 13px Inter; }")).toContain(VALUE);
    expect(await problems(".a { font-size: larger; }")).toContain(VALUE);
    expect(await problems(".a { line-height: 1.4; }")).toContain(VALUE);
  });

  it("requires letter-spacing to be a tracking token", async () => {
    expect(await problems(".a { letter-spacing: var(--mp-tracking-overline); }")).toEqual([]);
    expect(await problems(".a { letter-spacing: 0.08em; }")).toContain(VALUE);
    expect(await problems(".a { letter-spacing: 1px; }")).toContain(UNIT);
  });

  it("rejects font families that are not tokens", async () => {
    expect(await problems(".a { font-family: Inter, sans-serif; }")).toContain(
      "declaration-property-value-disallowed-list",
    );
    expect(await problems(".a { font-family: var(--mp-font-body); }")).toEqual([]);
  });

  it("requires a reason on every disable comment", async () => {
    const code =
      "/* stylelint-disable-next-line declaration-property-unit-disallowed-list */\n.a { padding: 3px; }";
    expect(await problems(code)).toContain("--report-descriptionless-disables");
  });

  it("accepts token-based styles and spec dimensions", async () => {
    const code = `.a {
      font: var(--mp-type-small);
      font-weight: 600;
      padding: var(--mp-space-3) var(--mp-space-2_5);
      border: 1px solid var(--mp-border-default);
      border-radius: var(--mp-radius-full);
      width: 52px;
      height: 32px;
      box-shadow: var(--mp-shadow-selected);
      font-family: var(--mp-font-display);
    }`;
    expect(await problems(code)).toEqual([]);
  });

  it("ignores token files", async () => {
    const result = await stylelint.lint({
      // eslint-disable-next-line no-restricted-syntax -- a deliberate hex proving token files are ignored
      code: ".a { color: #fff; }",
      codeFilename: fileURLToPath(new URL("../../../../../design/tokens.css", import.meta.url)),
      configFile,
    });
    expect(result.results[0]?.warnings ?? []).toEqual([]);
  });
});
