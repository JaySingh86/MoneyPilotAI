import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const WIDTHS = [1440, 1024, 390] as const;
export type Width = (typeof WIDTHS)[number];

/** Height only matters for fixed-height regions; the page is captured in full. */
export const HEIGHT = 900;

/**
 * Opens an app page in mock mode. The fonts are self-hosted (next/font), so every run renders the
 * same glyphs without network. `devbar=0` hides the mock-data toolbar.
 */
export async function openApp(
  page: Page,
  path: string,
  options: {
    scenario?: "base" | "shortfall" | "empty";
    params?: Record<string, string>;
    signedIn?: boolean;
  } = {},
): Promise<void> {
  if (options.signedIn === false) {
    await page.addInitScript(() => window.sessionStorage.setItem("mp.mock.auth", "out"));
  }
  const params = new URLSearchParams({
    devbar: "0",
    scenario: options.scenario ?? "base",
    ...options.params,
  });
  await page.goto(`${path}?${params.toString()}`);
}

/** Waits until the screen has its data (the heading that appears only after the plan loaded). */
export async function waitForOverview(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "Cash runway to payday" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

export async function waitForCalendar(page: Page): Promise<void> {
  await page.getByRole("heading", { level: 1, name: /^[A-Z][a-z]+ \d{4}$/ }).waitFor();
  await page.getByTestId("selected-day").waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The page itself never scrolls horizontally (DESIGN_SPEC §3.1). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal page scroll in px").toBeLessThanOrEqual(0);
}

/** The page's error banner. Next also keeps a route-announcer element with role="alert". */
export function errorBanner(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
