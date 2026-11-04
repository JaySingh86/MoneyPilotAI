// axe (WCAG 2.2 AA, color contrast on) on the WP-18 screens, at desktop and phone width.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { errorBanner, openApp } from "./helpers";
import { LIST_PAGES, waitForList } from "./lists-helpers";
import type { ListPage } from "./lists-helpers";

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
  test.describe(`axe lists at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const which of ["bills", "renewals", "goals", "tasks"] as ListPage[]) {
      test(LIST_PAGES[which].title, async ({ page }) => {
        await openApp(page, LIST_PAGES[which].path);
        await waitForList(page, which);
        await expectNoViolations(page);
      });
    }

    test("error states", async ({ page }) => {
      for (const [which, fault] of [
        ["/bills", "items"],
        ["/renewals", "renewals"],
        ["/goals", "goals"],
        ["/tasks", "tasks"],
      ] as const) {
        await openApp(page, which, { params: { mockFault: fault } });
        await errorBanner(page).waitFor();
        await expectNoViolations(page);
      }
    });
  });
}
