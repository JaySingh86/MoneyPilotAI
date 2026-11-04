import { defineConfig } from "vitest/config";

// Unit and component tests. The e2e and visual suite is Playwright (`pnpm --filter @mp/web e2e`).
// CSS modules map to their plain class names, as in packages/ui.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: [
      "lib/**/*.test.{ts,tsx}",
      "mocks/**/*.test.{ts,tsx}",
      "app/**/*.test.{ts,tsx}",
      "test/**/*.test.ts",
    ],
    testTimeout: 30_000,
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: "non-scoped" } },
    setupFiles: ["./test/setup.ts"],
    env: { NEXT_PUBLIC_MP_MOCK: "1" },
  },
});
