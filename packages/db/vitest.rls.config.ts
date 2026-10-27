import { defineConfig } from "vitest/config";

// `pnpm test:rls`: cross-household isolation tests (ADR-003). Assertions connect as mp_api / mp_worker
// only; the global setup does not even provide a migrator URL to this project (name "rls").
export default defineConfig({
  test: {
    name: "rls",
    include: ["test/rls/**/*.test.ts"],
    globalSetup: ["test/setup/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
