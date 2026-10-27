import { defineConfig } from "vitest/config";

// Architecture fitness tests (ARCHITECTURE §8): prove the lint and dependency rules actually fire.
export default defineConfig({
  test: {
    include: ["tooling/fitness/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
