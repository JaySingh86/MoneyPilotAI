import { defineConfig } from "vitest/config";

// Two projects. `unit` needs no Docker (`pnpm --filter @mp/api test:unit`). `int` (`*.int.test.ts`) uses a
// Postgres container started by its global setup (Testcontainers, Docker required, as for `pnpm test:rls`);
// the container starts only when the `int` project is selected. `vitest run` (pnpm test) runs both.
export default defineConfig({
  test: {
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
          globalSetup: ["src/auth/testing/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
