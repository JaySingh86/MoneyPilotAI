import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTokens, expectedCssVars, parseMediaRootVars, parseRootVars, renderTokensModule } from "./build";
import { cssVar, tokens } from "./index";

const root = new URL("../../../../", import.meta.url);
const jsonText = readFileSync(new URL("design/tokens.json", root), "utf8");
const cssText = readFileSync(new URL("design/tokens.css", root), "utf8");
const generatedText = readFileSync(new URL("tokens.generated.ts", import.meta.url), "utf8");

const freshJson = (): Record<string, unknown> => JSON.parse(jsonText) as Record<string, unknown>;

/** Sets `$value` at a dotted path in a parsed tokens.json copy. */
function setValue(json: Record<string, unknown>, path: string, value: unknown): void {
  let node: Record<string, unknown> = json;
  for (const key of path.split(".")) node = node[key] as Record<string, unknown>;
  node.$value = value;
}

describe("token consistency: design/tokens.css vs design/tokens.json", () => {
  it("the checked-in files agree", () => {
    expect(checkTokens(freshJson(), cssText)).toEqual([]);
  });

  it("fails when a CSS color diverges from the JSON", () => {
    const css = cssText.replace("--mp-income-text: #18794E;", "--mp-income-text: #18794F;");
    expect(css).not.toBe(cssText);
    expect(checkTokens(freshJson(), css)).toEqual([expect.stringContaining("--mp-income-text")]);
  });

  it("fails when a JSON value diverges from the CSS", () => {
    const json = freshJson();
    setValue(json, "radius.md", "11px");
    expect(checkTokens(json, cssText)).toEqual([expect.stringContaining("--mp-radius-md")]);
  });

  it("fails when a CSS variable is missing", () => {
    const css = cssText.replace(/^\s*--mp-partner-b-soft:.*$/m, "");
    expect(checkTokens(freshJson(), css)).toEqual([expect.stringMatching(/--mp-partner-b-soft.*missing/)]);
  });

  it("fails when the CSS has a variable the JSON does not define", () => {
    const css = cssText.replace("--mp-bg-track:", "--mp-bg-extra: #000000;\n  --mp-bg-track:");
    expect(checkTokens(freshJson(), css)).toEqual([
      expect.stringMatching(/--mp-bg-extra.*not in tokens\.json/),
    ]);
  });

  it("fails when the JSON gains a token with no CSS mapping", () => {
    const json = freshJson();
    (json.color as Record<string, unknown>).newRole = { x: { $value: "#000000", $type: "color" } };
    expect(checkTokens(json, cssText)).toEqual([expect.stringContaining("--mp-new-role-x")]);
  });

  it("checks composite values: typography, font stacks, focus ring, easing", () => {
    const json = freshJson();
    setValue(json, "font.family.body", ["Inter", "sans-serif"]);
    setValue(json, "size.focusRing", "3px");
    setValue(json, "motion.easing", [0, 0, 0.3, 1]);
    const typo = (json.typography as Record<string, { $value: Record<string, unknown> }>)["heading-2"];
    if (typo) typo.$value.lineHeight = "25px";
    const problems = checkTokens(json, cssText).join("\n");
    expect(problems).toContain("--mp-font-body");
    expect(problems).toContain("--mp-focus-ring");
    expect(problems).toContain("--mp-easing");
    expect(problems).toContain("--mp-type-heading-2");
  });

  it("checks letter spacing through the tracking variables", () => {
    const json = freshJson();
    setValue(json, "typography.display-xl", {
      ...((json.typography as Record<string, { $value: object }>)["display-xl"]?.$value ?? {}),
      letterSpacing: "-0.04em",
    });
    expect(checkTokens(json, cssText).join("\n")).toContain("--mp-tracking-display-xl");
  });

  it("maps tracking.tableHeader (Q-001) to --mp-tracking-table-header", () => {
    expect(expectedCssVars(freshJson()).get("--mp-tracking-table-header")).toBe("0.06em");
    const json = freshJson();
    setValue(json, "tracking.tableHeader", "0.05em");
    expect(checkTokens(json, cssText)).toEqual([expect.stringContaining("--mp-tracking-table-header")]);
  });

  it("asserts the reduced-motion override sets --mp-duration to 0ms", () => {
    expect(parseMediaRootVars(cssText, "(prefers-reduced-motion: reduce)").get("--mp-duration")).toBe("0ms");
    const slower = cssText.replace("--mp-duration: 0ms;", "--mp-duration: 100ms;");
    expect(slower).not.toBe(cssText);
    expect(checkTokens(freshJson(), slower)).toEqual([expect.stringContaining("reduced motion")]);
    const gone = cssText.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}\s*$/, "");
    expect(gone).not.toBe(cssText);
    expect(checkTokens(freshJson(), gone)).toEqual([expect.stringContaining("reduced motion")]);
  });

  it("checks the breakpoint comment (custom properties can't be used in media queries)", () => {
    const json = freshJson();
    setValue(json, "breakpoint.compact", "768px");
    expect(checkTokens(json, cssText).join("\n")).toContain("breakpoint.compact");
  });

  it("ignores whitespace and hex case, and the reduced-motion override", () => {
    const css = cssText
      .replace("rgba(17, 28, 43, 0.12)", "rgba(17,28,43,0.12)")
      .replace("#F2F4F7", "#f2f4f7");
    expect(checkTokens(freshJson(), css)).toEqual([]);
    expect(parseRootVars(cssText).get("--mp-duration")).toBe("150ms");
  });

  it("derives one CSS variable per mapped JSON token", () => {
    const vars = expectedCssVars(freshJson());
    expect(vars.get("--mp-partner-a-mark")).toBe("#0F7B6C");
    expect(vars.get("--mp-type-title")).toBe("600 15px/21px var(--mp-font-body)");
    expect(vars.get("--mp-easing")).toBe("cubic-bezier(0, 0, 0.2, 1)");
  });
});

describe("generated TS tokens", () => {
  it("is up to date with design/tokens.json (run `pnpm --filter @mp/ui tokens:gen`)", () => {
    expect(generatedText).toBe(renderTokensModule(freshJson()));
  });

  it("exposes raw values (Harbor, including income)", () => {
    expect(tokens.color.brand.default).toBe("#1F4E79");
    expect(tokens.color.income.text).toBe("#18794E");
    expect(tokens.color.partnerB.mark).toBe("#8A4FB0");
    expect(tokens.typography["display-xl"].fontFamily).toEqual([
      "Manrope",
      "Inter",
      "system-ui",
      "sans-serif",
    ]);
    expect(tokens.typography["display-xl"].fontSize).toBe("52px");
    expect(tokens.space["0_5"]).toBe("2px");
    expect(tokens.size.iconStroke).toBe(1.8);
    expect(tokens.size.focusRing).toBe("2px");
    expect(tokens.tracking.tableHeader).toBe("0.06em");
    expect(tokens.motion.easing).toEqual([0, 0, 0.2, 1]);
  });

  it("exposes CSS variable references that exist in tokens.css", () => {
    expect(cssVar.color.income.text).toBe("var(--mp-income-text)");
    expect(cssVar.color.partnerA.soft).toBe("var(--mp-partner-a-soft)");
    expect(cssVar.typography["display-xl"]).toEqual({
      font: "var(--mp-type-display-xl)",
      letterSpacing: "var(--mp-tracking-display-xl)",
    });
    expect(cssVar.typography["display-l"].letterSpacing).toBe("var(--mp-tracking-display-xl)");
    expect(cssVar.typography.body.letterSpacing).toBe("0");
    expect(cssVar.tracking.tableHeader).toBe("var(--mp-tracking-table-header)");
    expect(cssVar.tracking.displayXl).toBe("var(--mp-tracking-display-xl)");
    expect(cssVar.size.focusRing).toBe("var(--mp-focus-ring)");

    const defined = parseRootVars(cssText);
    const refs = generatedText.match(/var\(--mp-[a-z0-9_-]+\)/g) ?? [];
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of refs) {
      expect(defined.has(ref.slice(4, -1)), ref).toBe(true);
    }
  });
});
