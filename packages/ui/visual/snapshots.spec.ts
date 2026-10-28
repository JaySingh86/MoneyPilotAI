// Pixel snapshots (DESIGN_SPEC §9: matches the canvas at 1440, 1024 and 390). Baselines live in
// visual/__screenshots__ and are generated in the pinned Playwright image only.
import { expect, test } from "@playwright/test";
import { openStory } from "./helpers";

const WIDTHS = [1024, 390] as const;

const RUNWAY = [
  ["normal", "components-runwaychart--normal"],
  ["shortfall", "components-runwaychart--shortfall"],
] as const;

for (const width of WIDTHS) {
  test.describe(`RunwayChart at ${width}`, () => {
    test.use({ viewport: { width, height: 800 } });
    for (const [name, id] of RUNWAY) {
      test(`${name}${width === 390 ? " (scrolls sideways)" : ""}`, async ({ page }) => {
        await openStory(page, id);
        await expect(page.locator("#storybook-root")).toHaveScreenshot(`runway-${name}-${width}.png`);
      });
    }
  });
}

test.describe("HeroCard", () => {
  test.use({ viewport: { width: 1024, height: 600 } });
  for (const [name, id] of [
    ["default", "components-card--hero"],
    ["shortfall", "components-card--hero-shortfall"],
  ] as const) {
    test(name, async ({ page }) => {
      await openStory(page, id);
      await expect(page.locator("#storybook-root")).toHaveScreenshot(`hero-${name}-1024.png`);
    });
  }
});
