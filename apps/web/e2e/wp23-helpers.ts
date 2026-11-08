import type { Page } from "@playwright/test";

/** Email & imports has its data: queue, applied list, sources and the stat tile. */
export async function waitForImports(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "Electricity bill" }).waitFor();
  await page.getByText("Internet, $70.00 due Nov 5").waitFor();
  await page.getByText("Gmail · sam•••@gmail.com").waitFor();
  await page.getByText("92%").waitFor();
  await page.getByText("rivera-7k2@in.moneypilot.app").waitFor();
  await page.getByRole("button", { name: /Manage watched senders \(\d+\)/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

export async function waitForHousehold(page: Page): Promise<void> {
  await page.getByText("Email scan: 214 matched, 23 used").waitFor();
  await page.getByRole("switch", { name: "My connected email address" }).waitFor();
  await page.getByText("Renews Nov 26. Covers both of you.").waitFor();
  await page.getByText("Gmail · sam•••@gmail.com").waitFor();
  await page.evaluate(() => document.fonts.ready);
}

export async function waitForSetup(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "Add what comes in and goes out" }).waitFor();
  await page.getByText(/invited · waiting to join/).waitFor();
  await page.getByText("rivera-7k2@in.moneypilot.app").waitFor();
  await page.evaluate(() => document.fonts.ready);
}
