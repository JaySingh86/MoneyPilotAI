import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * Open one story on its own page (Storybook's iframe). The web fonts come from Google Fonts, which
 * is unreachable or slow in CI and would make pixels vary, so those requests are blocked and every
 * run uses the same fallback fonts of the pinned image. The a11y addon's own automatic axe run is
 * turned off (`a11y.manual`) so it can't collide with the axe run the tests start.
 */
export async function openStory(page: Page, id: string): Promise<void> {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=a11y.manual:true`);
  await page.waitForSelector("#storybook-root > *", { state: "attached" });
  await page.evaluate(() => document.fonts.ready);
}

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  type: string;
}

/** Every story in the built Storybook (`dist/storybook/index.json`, written by build-storybook). */
export function listStories(): StoryEntry[] {
  const index = JSON.parse(readFileSync("dist/storybook/index.json", "utf8")) as {
    entries: Record<string, StoryEntry>;
  };
  return Object.values(index.entries).filter((e) => e.type === "story");
}
