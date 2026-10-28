// Computed styles in a real browser: the `font:` shorthand must not reset tabular figures
// (DESIGN_SPEC §2.2), and amounts keep the display font.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openStory } from "./helpers";

const numeric = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).fontVariantNumeric);

test("hero amount uses tabular figures", async ({ page }) => {
  await openStory(page, "components-card--hero");
  expect(await numeric(page, '[class*="_heroAmount_"]')).toContain("tabular-nums");
});

test("runway values, dates and events use tabular figures", async ({ page }) => {
  await openStory(page, "components-runwaychart--normal");
  expect(await numeric(page, '[class*="_value_"]')).toContain("tabular-nums");
  expect(await numeric(page, '[class*="_date_"]')).toContain("tabular-nums");
});

test("KPI value and stepper output use tabular figures", async ({ page }) => {
  await openStory(page, "components-kpitile--income");
  expect(await numeric(page, '[class*="_value_"]')).toContain("tabular-nums");
  await openStory(page, "components-stepper--default");
  expect(await numeric(page, "output")).toContain("tabular-nums");
});

test("the 1024 runway plot is 230 px tall in total, headroom included", async ({ page }) => {
  await openStory(page, "components-runwaychart--shortfall");
  const height = await page
    .locator('[class*="_plot_"]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBe(230);
});
