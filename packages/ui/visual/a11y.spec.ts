// axe in a real browser on every story, with color-contrast ON (jsdom can't compute it). Any
// violation fails that story's test; the rule, selector and story are in the message.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { listStories, openStory } from "./helpers";

const stories = listStories();

// Stories render components alone, outside a page shell.
const PAGE_LEVEL_RULES = ["region", "page-has-heading-one", "landmark-one-main"];

// CalendarCell: DESIGN_SPEC §4.2 prescribes the aria-label "November 4, 1 item", which does not
// contain the cell's visible text (day number and event chips), so WCAG 2.5.3 Label in Name
// (axe `label-content-name-mismatch`) flags it. Kept as the spec says until Q-049 is answered.
const SPEC_EXCEPTIONS: Record<string, string[]> = {
  "Components/Calendar": ["label-content-name-mismatch"],
};

/** Storybook's a11y addon may be mid-run on a freshly loaded story; wait and try again. */
async function analyze(page: Page, disabled: string[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new AxeBuilder({ page })
        .include("#storybook-root")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .disableRules(disabled)
        .analyze();
    } catch (error) {
      if (attempt >= 8 || !String(error).includes("Axe is already running")) throw error;
      await page.waitForTimeout(500);
    }
  }
}

test("covers every story", () => {
  expect(stories.length).toBeGreaterThan(80);
});

for (const story of stories) {
  test(`axe: ${story.title} / ${story.name}`, async ({ page }) => {
    await openStory(page, story.id);
    const results = await analyze(page, [...PAGE_LEVEL_RULES, ...(SPEC_EXCEPTIONS[story.title] ?? [])]);
    const problems = results.violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`,
    );
    expect(problems).toEqual([]);
  });
}
