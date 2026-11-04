import { defineConfig } from "vitest/config";

// Two projects, as in apps/api. `unit` needs no Docker. `int` (`*.int.test.ts`) starts one Postgres
// container (Testcontainers) with the real roles and migrations, and runs real pg-boss against it.
export default defineConfig({
  test: {
    // One shared database: the sweep test counts jobs for every household, so test files must not overlap.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts", "node_modules/**"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "int",
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["src/testing/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
