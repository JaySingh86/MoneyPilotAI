/**
 * Architecture dependency rules (docs/architecture/ARCHITECTURE.md §3).
 * Patterns use (^|/) so the fitness tests can exercise them on fixture trees.
 * Every rule has a deliberate-violation test in tooling/fitness/architecture.test.ts.
 * @type {import('dependency-cruiser').IConfiguration}
 */
const pkg = (name) => `(^|/)packages/${name}/`;
const app = (name) => `(^|/)apps/${name}/`;
const ADAPTERS = "db|email|ai|notify|billing|bank|crypto";
// Third-party packages the pure engine may use (ADR-006, ADR-007). Extend only with an ADR.
const ENGINE_NPM_ALLOWLIST = ["@js-temporal/polyfill", "rrule"];

// npm packages the pure review-rules package may use in production code (none today).
const REVIEW_RULES_NPM_ALLOWLIST = [];

module.exports = {
  forbidden: [
    {
      name: "engine-is-pure",
      comment: "packages/engine must not import other internal packages or apps (ADR-005).",
      severity: "error",
      from: { path: pkg("engine") },
      to: { path: ["(^|/)packages/(?!engine/)", "(^|/)apps/"] },
    },
    {
      name: "engine-no-io",
      comment: "packages/engine must not import any Node core module (no I/O, clock, randomness).",
      severity: "error",
      from: { path: pkg("engine") },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "engine-npm-allowlist",
      comment: `packages/engine may only use these npm packages: ${ENGINE_NPM_ALLOWLIST.join(", ")}.`,
      severity: "error",
      // Tests and the fixture loader may use test libraries such as fast-check (Q-009).
      from: { path: pkg("engine"), pathNot: "\\.test\\.ts$|(^|/)packages/engine/src/testing/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
        pathNot: `node_modules/(${ENGINE_NPM_ALLOWLIST.map((p) => p.replace("/", "\\/")).join("|")})/`,
      },
    },
    {
      name: "web-boundaries",
      comment: "apps/web never imports db, engine, ai, email or crypto (numbers come from the API).",
      severity: "error",
      from: { path: app("web") },
      to: { path: [`(^|/)packages/(engine|detection|${ADAPTERS})/`] },
    },
    {
      name: "only-worker-touches-secrets",
      comment:
        "Only apps/worker may import email connectors and token decryption (BACKEND_PLAN §2.1). " +
        "apps/api may import packages/crypto/src/encrypt.ts only, to seal tokens at the OAuth callback.",
      severity: "error",
      from: { path: ["(^|/)apps/(?!worker/)", "(^|/)packages/(?!email/|crypto/)"] },
      to: {
        path: ["(^|/)packages/crypto/", "(^|/)packages/email/"],
        pathNot: "(^|/)packages/crypto/src/encrypt\\.ts$",
      },
    },
    {
      name: "api-ai-explain-ask-only",
      comment:
        "apps/api may use packages/ai only for Explain and Ask; extraction is worker-only (ARCHITECTURE §3).",
      severity: "error",
      from: { path: app("api") },
      to: { path: pkg("ai"), pathNot: "(^|/)packages/ai/src/(explain|ask)/" },
    },
    {
      name: "adapters-isolated",
      comment: "Adapter packages never import each other (ARCHITECTURE §3).",
      severity: "error",
      from: { path: `(^|/)packages/(db|ai|notify|billing|bank|crypto)/` },
      to: { path: `(^|/)packages/(${ADAPTERS})/`, pathNot: "(^|/)packages/$2/" },
    },
    {
      name: "email-only-uses-crypto",
      comment: "packages/email may import packages/crypto and no other adapter (ARCHITECTURE §3).",
      severity: "error",
      from: { path: pkg("email") },
      to: { path: "(^|/)packages/(db|ai|notify|billing|bank)/" },
    },
    {
      name: "engine-testing-only-in-tests",
      comment: "@mp/engine/testing (fixture loader, test generators) is for tests only.",
      severity: "error",
      from: { pathNot: ["\\.test\\.ts$", "(^|/)packages/engine/src/testing/", "(^|/)packages/[a-z]+/test/"] },
      to: { path: "(^|/)packages/engine/src/testing/" },
    },
    {
      name: "review-rules-is-pure",
      comment:
        "packages/review-rules must not import apps or other internal packages. It shares the auto-apply policy " +
        "between api and worker, so it may only use TYPES from packages/contracts (see the next rule).",
      severity: "error",
      from: { path: pkg("review-rules") },
      to: { path: ["(^|/)packages/(?!review-rules/|contracts/)", "(^|/)apps/"] },
    },
    {
      name: "review-rules-contracts-types-only",
      comment: "packages/review-rules imports only types from packages/contracts (no run-time dependency).",
      severity: "error",
      from: { path: pkg("review-rules") },
      to: { path: pkg("contracts"), dependencyTypesNot: ["type-only"] },
    },
    {
      name: "review-rules-no-io",
      comment: "packages/review-rules must not import any Node core module (no I/O, clock, randomness).",
      severity: "error",
      from: { path: pkg("review-rules"), pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "review-rules-npm-allowlist",
      comment: `packages/review-rules may use no npm packages in production code (allowlist: ${REVIEW_RULES_NPM_ALLOWLIST.length === 0 ? "none" : REVIEW_RULES_NPM_ALLOWLIST.join(", ")}). Extend only with an ADR.`,
      severity: "error",
      from: { path: pkg("review-rules"), pathNot: "\\.test\\.ts$" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
        pathNot: REVIEW_RULES_NPM_ALLOWLIST.length
          ? `node_modules/(${REVIEW_RULES_NPM_ALLOWLIST.map((p) => p.replace("/", "\\/")).join("|")})/`
          : "^$",
      },
    },
    {
      name: "packages-never-import-apps",
      severity: "error",
      from: { path: "(^|/)packages/" },
      to: { path: "(^|/)apps/" },
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import must resolve, otherwise the rules above cannot see it.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Don't exclude node_modules: that drops every npm dependency and blinds engine-npm-allowlist.
    // doNotFollow above keeps the crawl out of node_modules.
    exclude: { path: ["(^|/)dist/", "\\.next/", "__fixtures__", "next-env\\.d\\.ts$"] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
