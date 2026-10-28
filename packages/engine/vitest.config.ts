// Rules code must stay fully covered (WORK_PLAN WP-07): any uncovered statement, branch, function or line
// fails `pnpm test`. A plain object, so the config imports nothing (the engine npm allowlist, ADR-006).
export default {
  test: {
    globals: true,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/rules/**"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
};
