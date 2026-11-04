// Security headers, touch targets and layout details that only a real browser can check.
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, waitForCalendar, waitForOverview } from "./helpers";

test.describe("security headers", () => {
  test("every page has the CSP with a fresh nonce, HSTS and the rest", async ({ page }) => {
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await page.goto("/sign-in?devbar=0");
      const headers = response?.headers() ?? {};
      const csp = headers["content-security-policy"] ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toMatch(/google|gstatic/);
      nonces.push(/'nonce-([^']+)'/.exec(csp)?.[1] ?? "");
      expect(headers["strict-transport-security"]).toMatch(/max-age=\d+/);
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toContain("camera=()");
      expect(headers["x-powered-by"]).toBeUndefined();
    }
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test("the app runs under the policy: no CSP violations, no requests to other origins", async ({ page }) => {
    const problems: string[] = [];
    const origins = new Set<string>();
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) problems.push(m.text());
    });
    page.on("request", (r) => origins.add(new URL(r.url()).origin));
    await openApp(page, "/overview");
    await waitForOverview(page);
    await page.getByRole("button", { name: "See the math" }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await openApp(page, "/calendar");
    await waitForCalendar(page);
    expect(problems).toEqual([]);
    // The page itself and the API origin the mock answers for; nothing else (no fonts, no CDNs).
    expect([...origins].sort()).toEqual([new URL(page.url()).origin, "http://localhost:4000"].sort());
  });
});

async function boxes(locator: Locator): Promise<Array<{ label: string; width: number; height: number }>> {
  return locator.evaluateAll((els) =>
    els
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && !el.closest("[hidden]");
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40)}"`,
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }),
  );
}

/** Buttons, links, selects and text inputs; a checkbox is measured through its label row. */
async function controls(page: Page) {
  const selector = [
    "button",
    "a[href]",
    "select",
    "input:not([type=checkbox]):not([type=radio]):not([type=hidden])",
    "label:has(input[type=checkbox])",
  ].join(", ");
  return boxes(page.locator(selector));
}

test.describe("touch screens (pointer: coarse)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const [name, path, wait] of [
    ["Overview", "/overview", waitForOverview],
    ["Calendar", "/calendar", waitForCalendar],
  ] as const) {
    test(`${name}: every control is at least 44 px`, async ({ page }) => {
      await openApp(page, path);
      await wait(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const small = (await controls(page)).filter((c) => c.height < 44 && !c.label.startsWith('a "Skip'));
      expect(small).toEqual([]);
    });
  }

  test("the drawer's controls too", async ({ page }) => {
    await openApp(page, "/overview");
    await waitForOverview(page);
    await page.getByRole("button", { name: "Open menu" }).click();
    const small = (await boxes(page.getByRole("dialog").locator("button, a[href]"))).filter(
      (c) => c.height < 44,
    );
    expect(small).toEqual([]);
  });
});

test.describe("mouse (pointer: fine)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the §4 sizes: 40 px buttons, 36 px segments", async ({ page }) => {
    await openApp(page, "/overview");
    await waitForOverview(page);
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
    const add = await boxes(page.getByRole("button", { name: "Add bill or income" }));
    expect(add[0]?.height).toBe(40);
    const seg = await boxes(page.getByRole("group", { name: "Filter by owner" }).getByRole("button"));
    expect(seg.every((s) => s.height === 36)).toBe(true);
  });
});

test.describe("calendar chips", () => {
  for (const width of [1440, 1024]) {
    test(`names stay readable at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page, "/calendar");
      await waitForCalendar(page);
      const names = await page
        .locator("[data-date] [class*=chipName]")
        .evaluateAll((els) =>
          els.map((el) => ({ text: el.textContent ?? "", width: el.getBoundingClientRect().width })),
        );
      expect(names.length).toBeGreaterThan(15);
      // No name is squeezed to a few pixels: at least about four characters of 11 px text.
      for (const n of names) expect(n.width, n.text).toBeGreaterThanOrEqual(24);
      const rent = names.find((n) => n.text === "Rent");
      expect(rent?.width).toBeGreaterThan(26);
    });
  }
});

test.describe("runway tooltip", () => {
  test("is not cut off when the lowest day is the first bar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/overview", { scenario: "empty" });
    await waitForOverview(page);
    const tip = page.getByText(/^Lowest · /);
    await expect(tip).toBeVisible();
    const scroller = page.getByRole("group", { name: /Runway chart/ });
    const t = (await tip.boundingBox())!;
    const s = (await scroller.boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(s.x);
    expect(t.x + t.width).toBeLessThanOrEqual(s.x + s.width);
  });
});

test.describe("tables and narrow screens", () => {
  test("the bills table is a tab stop only when it scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/overview");
    await waitForOverview(page);
    await expect(page.getByRole("region", { name: "Bills due before payday" })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    const region = page.getByRole("region", { name: "Bills due before payday" });
    await expect(region).toHaveAttribute("tabindex", "0");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(region).toHaveCount(0);
  });

  test("at 390 the selected day is scrolled into view in the grid", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/calendar");
    await waitForCalendar(page);
    const cell = page.locator("[data-date='2026-11-04']");
    const card = page.locator("section[aria-label='November 2026 calendar']");
    await expect
      .poll(async () => {
        const c = (await cell.boundingBox())!;
        const k = (await card.boundingBox())!;
        return c.x >= k.x - 1 && c.x + c.width <= k.x + k.width + 1;
      })
      .toBe(true);
  });

  test("the sidebar stays in place while the page scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await openApp(page, "/overview");
    await waitForOverview(page);
    expect(
      await page
        .locator("nav[aria-label='Main']")
        .first()
        .evaluate((el) => getComputedStyle(el.parentElement!).position),
    ).toBe("sticky");
    await page.mouse.wheel(0, 1200);
    const top = await page.getByRole("link", { name: "Overview" }).first().boundingBox();
    expect(top?.y).toBeLessThan(700);
  });
});
