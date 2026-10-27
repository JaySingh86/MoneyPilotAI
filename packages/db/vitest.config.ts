import { defineConfig } from "vitest/config";

// `pnpm test`: unit + integration tests against a Testcontainers Postgres (test/setup/global-setup.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/integration/**/*.test.ts"],
    globalSetup: ["test/setup/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
