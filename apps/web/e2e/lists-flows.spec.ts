// WP-18 flows in a real browser: golden values, selecting, the stepper, approval and saving tasks.
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";
import { waitForList } from "./lists-helpers";

test.use({ viewport: { width: 1440, height: 900 } });

test("Bills & recurring shows the golden values and Electricity", async ({ page }) => {
  await openApp(page, "/bills");
  await waitForList(page, "bills");
  for (const text of ["$4,956.94", "$9,725.00", "$4,768.06"])
    await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Electricity" })).toBeVisible();
  await expect(page.getByText("Estimate ~$142.00 ±$30")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Bills and income that repeat" }).getByRole("row"),
  ).toHaveCount(19);
});

test("Subscriptions & renewals shows the golden values", async ({ page }) => {
  await openApp(page, "/renewals");
  await waitForList(page, "renewals");
  for (const text of ["$6,787.27", "$1,040.99", "+$55 / yr", "$181.87 / yr"])
    await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByText("16 items · about $566 a month")).toBeVisible();
});

test("Goals: the stepper recalculates, the suggestion fills $313, and approval is requested", async ({
  page,
}) => {
  await openApp(page, "/goals");
  await waitForList(page, "goals");
  await expect(page.getByText("$7,970")).toBeVisible();
  await page.getByRole("radio", { name: /Lake Tahoe trip/ }).click();
  const aside = page.getByRole("complementary", { name: "Selected goal" });
  await expect(aside.getByText("−$250")).toBeVisible();
  await aside.getByRole("button", { name: "Use $313 a month to stay on track" }).click();
  await expect(aside.getByText("On track", { exact: true })).toBeVisible();
  await aside.getByRole("button", { name: "Ask Jordan to approve" }).click();
  await expect(aside.getByText(/Waiting for Jordan to approve \$313 a month/)).toBeVisible();
});

test("Tasks: a checked task is saved and the badge drops", async ({ page }) => {
  await openApp(page, "/tasks");
  await waitForList(page, "tasks");
  const nav = page.getByRole("link", { name: /^Tasks/ });
  await expect(nav).toContainText("3");
  await page.getByRole("checkbox", { name: "Review 2 flagged subscriptions" }).click();
  await expect(
    page
      .getByRole("region", { name: "Done" })
      .getByRole("checkbox", { name: "Review 2 flagged subscriptions" }),
  ).toBeChecked();
  await expect(nav).toContainText("2");
});

test("no money moves: there is no Pay, Transfer or Send money control", async ({ page }) => {
  for (const path of ["/bills", "/renewals", "/goals", "/tasks"]) {
    await openApp(page, path);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await expect(page.getByRole("button", { name: /^(pay|transfer|send money)/i })).toHaveCount(0);
  }
});
