import { defineConfig, devices } from "@playwright/test";

// End-to-end, accessibility and visual tests for the web app, against `next dev` in mock mode (MSW
// answers the API from the golden fixture; no AWS). Pixel baselines are Linux Chromium renders from
// the pinned Playwright image: generate and check them with `pnpm --filter @mp/web e2e:update` and
// `e2e:docker`, the same image CI runs. They are arm64 renders (see e2e/README.md).
// 3100 is the dev port; set MP_E2E_PORT to run against (or start) a server elsewhere.
const PORT = Number(process.env.MP_E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    // Same pixels everywhere: no system theme, no motion, one device pixel per CSS pixel.
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    serviceWorkers: "allow",
    // Quick local runs of the non-visual specs with a browser you already have; the pixel
    // baselines only mean something in the pinned image.
    launchOptions: { executablePath: process.env.MP_E2E_CHROMIUM || undefined },
  },
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.002 },
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    env: { NEXT_PUBLIC_MP_MOCK: "1" },
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
