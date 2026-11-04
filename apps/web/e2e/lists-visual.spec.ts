// Pixel snapshots of the WP-18 screens at 1440, 1024 and 390, next to the canvas frames they match:
//   Web · Bills & recurring            -> bills-*.png
//   Web · Subscriptions & renewals     -> renewals-*.png
//   Web · Goals & planned expenses     -> goals-*.png
//   Web · Household tasks              -> tasks-*.png
// Each also asserts that the page never scrolls horizontally.
import { expect, test } from "@playwright/test";
import { HEIGHT, WIDTHS, expectNoHorizontalScroll, openApp } from "./helpers";
import { LIST_PAGES, waitForList } from "./lists-helpers";
import type { ListPage } from "./lists-helpers";

const PAGES: ListPage[] = ["bills", "renewals", "goals", "tasks"];

for (const width of WIDTHS) {
  test.describe(`lists at ${width}`, () => {
    test.use({ viewport: { width, height: HEIGHT } });
    for (const which of PAGES) {
      test(LIST_PAGES[which].title, async ({ page }) => {
        await openApp(page, LIST_PAGES[which].path);
        await waitForList(page, which);
        await expectNoHorizontalScroll(page);
        await expect(page).toHaveScreenshot(`${which}-${width}.png`, { fullPage: true });
      });
    }
  });
}
