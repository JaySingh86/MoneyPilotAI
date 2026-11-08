// The invite page (WP-15's email links to /invite?token=…): sign up or sign in, accept, land on the app.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

const token = (first: string) => `${first}${"a".repeat(42)}`;

for (const width of [1440, 390]) {
  test.describe(`invite at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("signed out: axe-clean, then sign in and join", async ({ page }) => {
      await openApp(page, "/invite", { signedIn: false, params: { token: token("V") } });
      await page.getByRole("heading", { name: "You’ve been invited to a household" }).waitFor();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`invite-${width}.png`, { fullPage: true });
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByLabel("Email").fill("jordan@rivera-household.example");
      await page.getByLabel("Password").fill("correct horse");
      await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
      await expect(page).toHaveURL(/\/overview/);
    });

    test("an expired invitation is explained, axe-clean", async ({ page }) => {
      await openApp(page, "/invite", { params: { token: token("E") } });
      await page.getByRole("heading", { name: "This invitation has expired." }).first().waitFor();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      await expect(page).toHaveURL(/\/invite/);
    });
  });
}
