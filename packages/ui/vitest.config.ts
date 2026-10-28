import { defineConfig } from "vitest/config";

// Token tests (WP-04) run in Node; components (WP-10) render in jsdom. CSS modules map to their
// plain class names so snapshots are readable and only change when markup or classes change.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: "non-scoped" } },
    projects: [
      {
        extends: true,
        test: { name: "tokens", include: ["src/tokens/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "components",
          include: ["src/components/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["src/components/test/setup.ts"],
        },
      },
    ],
  },
});
