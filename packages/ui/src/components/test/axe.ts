import axe from "axe-core";
import { expect } from "vitest";

// WCAG 2.2 AA rule set (DESIGN_SPEC §8). Color contrast can't be computed in jsdom (no layout,
// CSS variables unresolved); the token pairs are verified in DESIGN_SPEC §8 and the Storybook
// a11y addon checks contrast in a real browser.
const RUN_OPTIONS: axe.RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  rules: {
    "color-contrast": { enabled: false },
    // Components render outside a page; landmarks and page headings are the app shell's job.
    region: { enabled: false },
    "page-has-heading-one": { enabled: false },
    "landmark-one-main": { enabled: false },
  },
};

/** Fails the test with a readable list when axe finds any violation. */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, RUN_OPTIONS);
  const problems = results.violations.map(
    (v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
  );
  expect(problems).toEqual([]);
}
