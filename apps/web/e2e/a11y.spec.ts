// axe (WCAG 2.2 AA, color contrast on) on every screen and state, at desktop and phone width.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { errorBanner, openApp, waitForCalendar, waitForOverview } from "./helpers";

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const problems = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`,
  );
  expect(problems).toEqual([]);
}

for (const width of [1440, 390]) {
  test.describe(`axe at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("Overview, on track", async ({ page }) => {
      await openApp(page, "/overview");
      await waitForOverview(page);
      await expectNoViolations(page);
    });

    test("Overview, shortfall", async ({ page }) => {
      await openApp(page, "/overview", { scenario: "shortfall" });
      await waitForOverview(page);
      await expectNoViolations(page);
    });

    test("Overview, empty and error states", async ({ page }) => {
      await openApp(page, "/overview", { scenario: "empty" });
      await waitForOverview(page);
      await expectNoViolations(page);
      await openApp(page, "/overview", { params: { mockFault: "plan" } });
      await errorBanner(page).waitFor();
      await expectNoViolations(page);
    });

    test("Overview, See the math drawer open", async ({ page }) => {
      await openApp(page, "/overview");
      await waitForOverview(page);
      await page.getByRole("button", { name: "See the math" }).click();
      await page.getByRole("dialog").waitFor();
      await expectNoViolations(page);
    });

    test("Calendar", async ({ page }) => {
      await openApp(page, "/calendar");
      await waitForCalendar(page);
      await expectNoViolations(page);
    });

    test("Sign in", async ({ page }) => {
      await openApp(page, "/sign-in", { signedIn: false });
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      await expectNoViolations(page);
    });
  });
}
