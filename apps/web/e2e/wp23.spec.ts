// WP-23: Email & imports, Members & privacy and household setup. Functional flows, axe, and pixel
// snapshots at 1440, 1024 and 390 next to the canvas frames they match:
//   Web · Email & imports (review queue)  → imports-*.png
//   Web · Members & privacy               → household-*.png
//   Mobile · Household setup              → setup-*.png
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { HEIGHT, WIDTHS, expectNoHorizontalScroll, openApp } from "./helpers";
import { waitForHousehold, waitForImports, waitForSetup } from "./wp23-helpers";

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const problems = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`,
  );
  expect(problems).toEqual([]);
}

for (const width of WIDTHS) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("Email & imports", async ({ page }) => {
      await openApp(page, "/imports");
      await waitForImports(page);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveScreenshot(`imports-${width}.png`, { fullPage: true });
    });

    test("Members & privacy", async ({ page }) => {
      await openApp(page, "/settings/household");
      await waitForHousehold(page);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveScreenshot(`household-${width}.png`, { fullPage: true });
    });

    test("Household setup", async ({ page }) => {
      await openApp(page, "/setup", { params: { setup: "invited" } });
      await waitForSetup(page);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveScreenshot(`setup-${width}.png`, { fullPage: true });
    });
  });
}

test.describe("states", () => {
  test.use({ viewport: { width: 1440, height: HEIGHT } });

  test("Email & imports, all caught up", async ({ page }) => {
    await openApp(page, "/imports", { scenario: "empty" });
    await page.getByText("All caught up. New bills and renewals will appear here as they arrive.").waitFor();
    await page.getByText("92%").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalScroll(page);
    await expect(page).toHaveScreenshot("imports-empty-1440.png", { fullPage: true });
  });

  test("Household setup, CSV found", async ({ page }) => {
    await openApp(page, "/setup", { params: { setup: "invited" } });
    await waitForSetup(page);
    await page.getByRole("radio", { name: /Import a bank CSV/ }).click();
    await page.getByLabel("Bank CSV file").setInputFiles({
      name: "checking-oct.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("date,description,amount\n"),
    });
    await page.getByText("Found in checking-oct.csv").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalScroll(page);
    await expect(page).toHaveScreenshot("setup-csv-1440.png", { fullPage: true });
  });
});

test.describe("flows", () => {
  test.use({ viewport: { width: 1440, height: HEIGHT } });

  test("confirming electricity updates the queue and the nav badge", async ({ page }) => {
    await openApp(page, "/imports");
    await waitForImports(page);
    const nav = page
      .getByRole("navigation")
      .getByRole("link", { name: /Email & imports/ })
      .first();
    await expect(nav).toContainText("4");
    await page
      .getByRole("article", { name: "Electricity bill" })
      .getByRole("button", { name: "Confirm" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Electricity set to $151.37. Safe to spend is now $997." }),
    ).toBeVisible();
    await expect(page.locator("#main").getByText("3 to review")).toBeVisible();
    await expect(nav).toContainText("3");
  });

  test("undo, and a partner's item asks for approval", async ({ page }) => {
    await openApp(page, "/imports");
    await waitForImports(page);
    await page.getByRole("button", { name: "Undo Internet, $70.00 due Nov 5" }).click();
    await expect(page.getByText("Internet is back to how it was.")).toBeVisible();
    await page.getByRole("button", { name: /^Undo Car insurance renewal/ }).click();
    await expect(page.getByText("This is on Jordan’s item. Ask Jordan to approve it.")).toBeVisible();
  });

  test("leaving asks for a 2-step code, then goes on to setup", async ({ page }) => {
    await openApp(page, "/settings/household", { params: { mfa: "required" } });
    await waitForHousehold(page);
    await page.getByRole("button", { name: "Leave…" }).click();
    await page
      .getByRole("dialog", { name: "Leave the household?" })
      .getByRole("button", { name: "Leave household" })
      .click();
    const step = page.getByRole("dialog", { name: "Confirm it’s you" });
    await step.getByLabel("6-digit code").fill("123456");
    await step.getByRole("button", { name: "Confirm" }).click();
    await expect(page).toHaveURL(/\/setup/);
  });

  test("deleting the household needs the name typed", async ({ page }) => {
    await openApp(page, "/settings/household");
    await waitForHousehold(page);
    await page.getByRole("button", { name: "Delete household…" }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Delete household" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type “Rivera household” to confirm").fill("Rivera household");
    await expect(confirm).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

for (const width of [1440, 390]) {
  test.describe(`axe at ${width}`, () => {
    test.use({ viewport: { width, height: HEIGHT } });

    test("Email & imports", async ({ page }) => {
      await openApp(page, "/imports");
      await waitForImports(page);
      await expectNoViolations(page);
    });

    test("Email & imports, empty and dialogs", async ({ page }) => {
      await openApp(page, "/imports", { scenario: "empty" });
      await page
        .getByText("All caught up. New bills and renewals will appear here as they arrive.")
        .waitFor();
      await expectNoViolations(page);
      await page.getByRole("button", { name: /Manage watched senders/ }).click();
      await page.getByRole("dialog").getByRole("switch").first().waitFor();
      await expectNoViolations(page);
    });

    test("Members & privacy", async ({ page }) => {
      await openApp(page, "/settings/household");
      await waitForHousehold(page);
      await expectNoViolations(page);
    });

    test("Members & privacy, delete dialog", async ({ page }) => {
      await openApp(page, "/settings/household");
      await waitForHousehold(page);
      await page.getByRole("button", { name: "Delete household…" }).click();
      await page.getByRole("dialog").waitFor();
      await expectNoViolations(page);
    });

    test("Household setup", async ({ page }) => {
      await openApp(page, "/setup", { params: { setup: "invited" } });
      await waitForSetup(page);
      await expectNoViolations(page);
    });
  });
}
