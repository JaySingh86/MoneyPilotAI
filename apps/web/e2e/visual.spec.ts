// Pixel snapshots at 1440, 1024 and 390 (DESIGN_SPEC §9), next to the canvas frames they match:
//   Web · Overview (before payday)      → overview-base-*.png
//   Web · Safe-to-spend states          → overview-shortfall-*.png
//   Web · Shared bills calendar         → calendar-base-*.png
// Each also asserts that the page never scrolls horizontally.
import { expect, test } from "@playwright/test";
import {
  HEIGHT,
  errorBanner,
  WIDTHS,
  expectNoHorizontalScroll,
  openApp,
  waitForCalendar,
  waitForOverview,
} from "./helpers";

for (const width of WIDTHS) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("Overview, on track", async ({ page }) => {
      await openApp(page, "/overview");
      await waitForOverview(page);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveScreenshot(`overview-base-${width}.png`, { fullPage: true });
    });

    test("Overview, shortfall", async ({ page }) => {
      await openApp(page, "/overview", { scenario: "shortfall" });
      await waitForOverview(page);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveScreenshot(`overview-shortfall-${width}.png`, { fullPage: true });
    });

    test("Calendar", async ({ page }) => {
      await openApp(page, "/calendar");
      await waitForCalendar(page);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveScreenshot(`calendar-base-${width}.png`, { fullPage: true });
    });
  });
}

test.describe("states", () => {
  test.use({ viewport: { width: 1440, height: HEIGHT } });

  test("Overview, new household (empty states)", async ({ page }) => {
    await openApp(page, "/overview", { scenario: "empty" });
    await waitForOverview(page);
    await expectNoHorizontalScroll(page);
    await expect(page).toHaveScreenshot("overview-empty-1440.png", { fullPage: true });
  });

  test("Overview, error", async ({ page }) => {
    await openApp(page, "/overview", { params: { mockFault: "plan" } });
    await errorBanner(page).waitFor();
    await expect(page).toHaveScreenshot("overview-error-1440.png", { fullPage: true });
  });

  test("Sign in", async ({ page }) => {
    await openApp(page, "/sign-in", { signedIn: false });
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("sign-in-1440.png", { fullPage: true });
  });
});
