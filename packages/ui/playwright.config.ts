import { defineConfig, devices } from "@playwright/test";

// Visual and browser accessibility tests against the built Storybook (`dist/storybook`).
// Pixel baselines are Linux Chromium renders and must be generated inside the pinned Playwright
// image (`pnpm --filter @mp/ui test:visual:update`), the same image CI runs. See scripts/.
const PORT = 6007;

export default defineConfig({
  testDir: "./visual",
  // One baseline per test and platform-independent name: only the pinned Linux image produces them.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    // Same pixels everywhere: no system theme, no motion, no device scale surprises.
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.002 },
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `pnpm exec http-server dist/storybook -p ${PORT} -a 127.0.0.1 -s -c-1`,
    url: `http://127.0.0.1:${PORT}/iframe.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
