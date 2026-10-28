// @vitest-environment node
// The `font:` shorthand resets font-variant-numeric, so any class that shows an amount, date or
// count must declare `font-variant-numeric: tabular-nums` AFTER its `font:` (DESIGN_SPEC §2.2).
import { describe, expect, it } from "vitest";
import { cssModuleFiles, parseRules } from "./css-rules";

// Classes that render amounts, dates or counts (by file and selector).
const NUMERIC: Array<[string, string]> = [
  ["card/card.module.css", ".heroAmount"],
  ["card/card.module.css", ".heroMobile .heroAmount"],
  ["card/card.module.css", ".heroBreakdown"],
  ["kpi-tile/kpi-tile.module.css", ".value"],
  ["kpi-tile/kpi-tile.module.css", ".legendAmount"],
  ["stepper/stepper.module.css", ".value"],
  ["progress-bar/progress-bar.module.css", ".percent"],
  ["progress-bar/progress-bar.module.css", ".caption"],
  ["review-queue/review-queue-item.module.css", ".meta"],
  ["review-queue/review-queue-item.module.css", ".value"],
  ["runway-chart/runway-chart.module.css", ".value"],
  ["runway-chart/runway-chart.module.css", ".label"],
  ["filter-pills/filter-pills.module.css", ".count"],
  ["amount/amount.module.css", ".amount"],
  ["table/table.module.css", ".amount"],
  ["table/table.module.css", ".total"],
  ["list-row/list-row.module.css", ".dateBlock"],
  ["math-breakdown/math-breakdown.module.css", ".math"],
  ["calendar/calendar.module.css", ".dayNumber"],
  ["calendar/calendar.module.css", ".chipAmount"],
  ["status-chip/status-chip.module.css", ".chip"],
];

describe("tabular figures", () => {
  const rules = cssModuleFiles().flatMap((f) => parseRules(f));

  it("never declares font-variant-numeric before the font shorthand (which would reset it)", () => {
    for (const rule of rules) {
      const props = rule.declarations.map((d) => d.prop);
      const font = props.indexOf("font");
      const numeric = props.indexOf("font-variant-numeric");
      if (font >= 0 && numeric >= 0) {
        expect(numeric, `${rule.file} ${rule.selectors.join(", ")}`).toBeGreaterThan(font);
      }
    }
  });

  for (const [file, selector] of NUMERIC) {
    it(`${file} ${selector} sets tabular-nums`, () => {
      const found = rules.filter((r) => r.file === file && r.selectors.includes(selector));
      expect(found.length, "rule exists").toBeGreaterThan(0);
      const rule = found.find((r) => r.declarations.some((d) => d.prop === "font-variant-numeric"));
      expect(rule, "declares font-variant-numeric").toBeDefined();
      expect(rule?.declarations.find((d) => d.prop === "font-variant-numeric")?.value).toBe("tabular-nums");
    });
  }

  it("has no use of a shared helper class that a font shorthand could override", () => {
    expect(rules.some((r) => r.selectors.includes(".tabular"))).toBe(false);
  });
});
