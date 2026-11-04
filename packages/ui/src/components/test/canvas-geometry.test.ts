// @vitest-environment node
// Canvas-over-spec decisions from the WP-10 review: Q-045 (web icon button color) and Q-046 (error
// banner padding and radius). Read from the CSS modules, since jsdom doesn't resolve token values.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { componentsRoot, parseRules } from "./css-rules";

function declarations(file: string, selector: string): Record<string, string> {
  const rule = parseRules(`${componentsRoot}${file}`).find((r) => r.selectors.includes(selector));
  return Object.fromEntries((rule?.declarations ?? []).map((d) => [d.prop, d.value]));
}

describe("canvas geometry", () => {
  it("draws web icon buttons in text.secondary (Q-045)", () => {
    expect(declarations("button/button.module.css", ".iconButton").color).toBe("var(--mp-text-secondary)");
  });

  it("draws the error banner with padding 12×14 and radius lg (Q-046)", () => {
    const error = declarations("states/states.module.css", ".error");
    expect(error.padding).toBe("var(--mp-space-3) var(--mp-space-3_5)");
    expect(error["border-radius"]).toBe("var(--mp-radius-lg)");
  });
});

describe("calendar chips in narrow cells", () => {
  it("keeps the name readable: it has a minimum width and the amount wraps instead of squeezing it", () => {
    expect(declarations("calendar/calendar.module.css", ".chip")["flex-wrap"]).toBe("wrap");
    expect(declarations("calendar/calendar.module.css", ".chipName")["min-width"]).toBe("4.5ch");
  });
});

describe("touch screens", () => {
  const coarse = (file: string) => {
    const css = readFileSync(`${componentsRoot}${file}`, "utf8");
    const at = css.indexOf("@media (pointer: coarse)");
    return at < 0 ? "" : css.slice(at);
  };

  it("makes every kit control 44 px tall at (pointer: coarse) and leaves the mouse sizes alone", () => {
    expect(coarse("button/button.module.css")).toMatch(
      /\.web,\s*\.compact\s*\{\s*height: var\(--mp-touch-target\)/,
    );
    expect(coarse("button/button.module.css")).toMatch(/\.icon-web\s*\{\s*height: var\(--mp-touch-target\)/);
    expect(coarse("segmented-control/segmented-control.module.css")).toMatch(
      /\.segment\s*\{\s*height: var\(--mp-touch-target\)/,
    );
    expect(coarse("filter-pills/filter-pills.module.css")).toMatch(
      /\.pill\s*\{\s*height: var\(--mp-touch-target\)/,
    );
    expect(coarse("states/states.module.css")).toMatch(/\.retry\s*\{[^}]*padding-block/);
    // With a mouse the §4 sizes stay (the rules before the media query).
    const mouse = (file: string) => {
      const css = readFileSync(`${componentsRoot}${file}`, "utf8");
      return css.slice(0, css.indexOf("@media (pointer: coarse)"));
    };
    expect(mouse("button/button.module.css")).toMatch(
      /\.button \{[^}]*height: var\(--mp-button-height-web\)/,
    );
    expect(mouse("segmented-control/segmented-control.module.css")).toMatch(
      /\.segment \{[^}]*height: var\(--mp-segment-height\)/,
    );
  });
});
