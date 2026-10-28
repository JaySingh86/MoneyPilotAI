// @vitest-environment node
// Every control shows the focus ring (DESIGN_SPEC §4, §8): each selector that styles a clickable
// element (cursor: pointer) needs a :focus-visible rule with the focus-ring token outline.
import { describe, expect, it } from "vitest";
import { componentsRoot, cssModuleFiles, parseRules } from "./css-rules";

// Labels are clickable but not focusable; their input draws the ring.
const NOT_FOCUSABLE = new Set([".checkboxLabel"]);

const baseOf = (selector: string) => selector.replace(/(:hover|:not\([^)]*\)|:focus-visible)+$/g, "");

describe("focus ring", () => {
  const files = cssModuleFiles();

  it("finds the component CSS modules", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const file of files) {
    const rules = parseRules(file);
    const ringed = new Set(
      rules
        .filter((r) => r.declarations.some((d) => d.prop === "outline" && d.value === "var(--mp-focus-ring)"))
        .filter((r) =>
          r.declarations.some((d) => d.prop === "outline-offset" && d.value === "var(--mp-focus-offset)"),
        )
        .flatMap((r) => r.selectors.filter((s) => s.endsWith(":focus-visible")).map((s) => baseOf(s))),
    );
    const clickable = new Set(
      rules
        .filter((r) => r.declarations.some((d) => d.prop === "cursor" && d.value === "pointer"))
        .flatMap((r) => r.selectors.map(baseOf))
        .filter((s) => !s.includes("::") && !NOT_FOCUSABLE.has(s)),
    );
    for (const selector of clickable) {
      it(`${file.slice(componentsRoot.length)}: ${selector} draws the token focus ring on :focus-visible`, () => {
        expect(ringed.has(selector)).toBe(true);
      });
    }
  }
});
