// Waits for the WP-18 screens (Bills, Renewals, Goals, Tasks) to have their data and fonts.
import type { Page } from "@playwright/test";

export const LIST_PAGES = {
  bills: { path: "/bills", ready: "Selected bill", title: "Bills & recurring" },
  renewals: { path: "/renewals", ready: "Selected renewal", title: "Subscriptions & renewals" },
  goals: { path: "/goals", ready: "Selected goal", title: "Goals & planned expenses" },
  tasks: { path: "/tasks", ready: "Due this week", title: "Household tasks" },
} as const;

export type ListPage = keyof typeof LIST_PAGES;

export async function waitForList(page: Page, which: ListPage): Promise<void> {
  const { ready } = LIST_PAGES[which];
  if (which === "tasks") await page.getByRole("region", { name: ready }).waitFor();
  else await page.getByRole("complementary", { name: ready }).waitFor();
  if (which === "goals") await page.getByText("Result", { exact: true }).waitFor();
  if (which === "bills") await page.getByText("Last time").waitFor();
  await page.evaluate(() => document.fonts.ready);
}
