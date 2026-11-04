// Flows in a real browser: golden values, keyboard use, the drawer, sign-in and the bootstrap call.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { errorBanner, openApp, waitForCalendar, waitForOverview } from "./helpers";

const bootstrapCalls = (page: Page) => page.evaluate(() => window.__mpMock?.state.bootstrapCalls ?? -1);

test.describe("Overview", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("renders the golden values", async ({ page }) => {
    await openApp(page, "/overview");
    await waitForOverview(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("10 days to payday. Here’s the plan.");
    const hero = page.getByRole("region", { name: "Safe to spend until Fri, Nov 6" });
    await expect(hero).toContainText("$1,007");
    await expect(hero).toContainText("Lowest projected balance $1,507 on Nov 5");
    await expect(page.getByText("≈ $100 a day for 10 days")).toBeVisible();
    await expect(page.getByText("$4,792.99").first()).toBeVisible();
    await expect(page.getByText("$2,900.00", { exact: true })).toBeVisible();
    await expect(page.getByText("Lowest · $1,507")).toBeVisible();
    await expect(page.getByText("Lake Tahoe trip is $250 behind")).toBeVisible();
  });

  test("shows the shortfall state", async ({ page }) => {
    await openApp(page, "/overview", { scenario: "shortfall" });
    await waitForOverview(page);
    await expect(page.getByText("$793 short")).toBeVisible();
    await expect(page.getByText("Lowest · −$293")).toBeVisible();
    await expect(page.getByText("$109 short, never below $0")).toBeVisible();
  });

  test("the mock toolbar switches the scenario", async ({ page }) => {
    await page.goto("/overview");
    await waitForOverview(page);
    await page.getByRole("group", { name: "Scenario" }).getByRole("button", { name: "Shortfall" }).click();
    await expect(page.getByText("$793 short")).toBeVisible();
  });

  test("See the math opens a dialog, and Escape closes it and returns focus", async ({ page }) => {
    await openApp(page, "/overview");
    await waitForOverview(page);
    const opener = page.getByRole("button", { name: "See the math" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "See the math" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("$1,507.01");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("filtering the bills table recalculates its total", async ({ page }) => {
    await openApp(page, "/overview");
    await waitForOverview(page);
    const table = page.getByRole("table", { name: "Bills due before payday" });
    await expect(table).toContainText("$4,792.99");
    await page
      .getByRole("group", { name: "Filter by owner" })
      .getByRole("button", { name: "Jordan" })
      .click();
    await expect(table).toContainText("$2,999.00");
    await expect(table).not.toContainText("Daycare");
  });

  test("shows the loading state, then the plan", async ({ page }) => {
    await openApp(page, "/overview", { params: { mockDelay: "1500" } });
    await expect(page.getByText("Loading your plan")).toBeAttached(); // skeletons show after 300 ms (§5.3)
    await waitForOverview(page);
  });

  test("shows the error banner and recovers on retry", async ({ page }) => {
    await openApp(page, "/overview", { params: { mockFault: "plan" } });
    const alert = errorBanner(page);
    await expect(alert).toContainText("We couldn’t load your plan.");
    await page.evaluate(() => window.__mpMock?.setFault("plan", false));
    await alert.getByRole("button", { name: "Try again" }).click();
    await waitForOverview(page);
  });
});

test.describe("Calendar", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows November with the golden totals and Nov 4 selected", async ({ page }) => {
    await openApp(page, "/calendar");
    await waitForCalendar(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("November 2026");
    await expect(page.getByTestId("selected-day")).toHaveText("Wednesday, Nov 4");
    const glance = page.getByRole("region", { name: "November at a glance" });
    await expect(glance).toContainText("$9,200.00");
    await expect(glance).toContainText("−$5,590.94");
    await expect(glance).toContainText("−$800.00");
    await expect(glance).toContainText("$2,809.06");
  });

  test("keyboard: one tab stop, arrow keys move between days, Enter selects", async ({ page }) => {
    await openApp(page, "/calendar");
    await waitForCalendar(page);
    const days = page.getByRole("group", { name: "Days" });
    // Tab from the owner filter and the add button reaches the selected day, and only that day.
    await page.getByRole("button", { name: "Add to calendar" }).focus();
    await page.keyboard.press("Tab");
    await expect(days.locator("[data-date='2026-11-04']")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(days.locator("[data-date='2026-11-05']")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("selected-day")).toHaveText("Friday, Nov 6");
    await expect(page.getByRole("heading", { name: "Goal transfer" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(days.locator("[data-date='2026-11-13']")).toBeFocused();
    // Tab leaves the grid in one step.
    await page.keyboard.press("Tab");
    await expect(days.locator("[data-date='2026-11-14']")).not.toBeFocused();
  });

  test("cells are named from their visible content (WCAG 2.5.3)", async ({ page }) => {
    await openApp(page, "/calendar");
    await waitForCalendar(page);
    const cell = page.locator("[data-date='2026-11-04']");
    await expect(cell).toHaveAccessibleName(/November 4\s*,\s*Car insurance renewal\s*−\$684/);
    await expect(cell).toHaveAccessibleDescription("1 item");
    await expect(cell).toContainText("Car insurance renewal");
  });
});

test.describe("Shell", () => {
  test("phone width: a top bar with a menu drawer instead of the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/overview");
    await waitForOverview(page);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer.getByRole("link", { name: "Calendar" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });

  test("desktop: the sidebar marks the current page and shows the nav badges", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/calendar");
    await waitForCalendar(page);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /Tasks/ })).toContainText("3");
    await expect(nav.getByRole("link", { name: /Email & imports/ })).toContainText("4");
  });
});

test.describe("Sign-in and bootstrap", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a signed-in visit calls POST /me/bootstrap, and so does each token refresh", async ({ page }) => {
    await openApp(page, "/overview");
    await waitForOverview(page);
    expect(await bootstrapCalls(page)).toBe(1);
    await page.evaluate(() => window.__mpMock?.auth.simulateTokenRefresh());
    await expect.poll(() => bootstrapCalls(page)).toBe(2);
  });

  test("signed out, the app sends you to sign-in; signing in syncs the user and opens the Overview", async ({
    page,
  }) => {
    await openApp(page, "/overview", { signedIn: false });
    await expect(page).toHaveURL(/\/sign-in/);
    await page.getByLabel("Email").fill("sam@rivera-household.example");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(errorBanner(page)).toContainText("don’t match");
    await page.getByLabel("Password").fill("correct horse");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/overview/);
    await waitForOverview(page);
    expect(await bootstrapCalls(page)).toBe(1);
  });

  test("the MFA challenge, then sign out", async ({ page }) => {
    await openApp(page, "/sign-in", { signedIn: false });
    await page.getByLabel("Email").fill("sam@rivera-household.example");
    await page.getByLabel("Password").fill("mfa");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/overview/);
    await waitForOverview(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
