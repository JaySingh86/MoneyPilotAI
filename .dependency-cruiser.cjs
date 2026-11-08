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

// npm packages the pure detection package may use in production code (BACKEND_PLAN §3: papaparse; ADR-007).
const DETECTION_NPM_ALLOWLIST = ["papaparse", "@js-temporal/polyfill"];

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
      comment:
        "apps/web never imports db, engine, ai, email or crypto (numbers come from the API). " +
        "The one exception is apps/web/mocks, the dev-only MSW stand-in for the planning API, which " +
        "runs the engine on the golden fixture (WP-17). It is never imported statically and the " +
        "production build refuses to enable it.",
      severity: "error",
      from: { path: app("web"), pathNot: "(^|/)apps/web/mocks/" },
      to: { path: [`(^|/)packages/(engine|detection|${ADAPTERS})/`] },
    },
    {
      name: "mocks-only-from-providers",
      comment:
        "apps/web/mocks is the dev-only mock API. Only app/providers.tsx may import it (behind a " +
        "NODE_ENV check that production builds drop); no screen or lib module may, and tests are exempt.",
      severity: "error",
      from: {
        path: "(^|/)apps/web/(app|lib)/",
        pathNot: ["(^|/)apps/web/app/providers\\.tsx$", "\\.test\\.tsx?$"],
      },
      to: { path: "(^|/)apps/web/mocks/" },
    },
    {
      name: "only-worker-touches-secrets",
      comment:
        "Only apps/worker may import email connectors and token decryption (BACKEND_PLAN §2.1). " +
        "apps/api may import packages/crypto/src/encrypt.ts only, to seal tokens at the OAuth callback, and " +
        "packages/email/src/oauth/index.ts only (OAuth consent and code exchange, revoke, PKCE, address hash; WP-21), " +
        "plus the fakes in testing/. Reading a mailbox (refresh, listChanges, fetchRaw) stays out of the API.",
      severity: "error",
      from: { path: ["(^|/)apps/(?!worker/)", "(^|/)packages/(?!email/|crypto/)"] },
      to: {
        path: ["(^|/)packages/crypto/", "(^|/)packages/email/"],
        pathNot: [
          "(^|/)packages/crypto/src/encrypt\\.ts$",
          "(^|/)packages/email/src/oauth/index\\.ts$",
          "(^|/)packages/email/testing/",
        ],
      },
    },
    {
      name: "api-no-decrypt-reachable",
      comment:
        "Hard rule 7: only apps/worker decrypts a token. Nothing apps/api imports, directly or through any chain of " +
        "imports (dynamic import() included), may reach crypto code that can decrypt or unwrap a key.",
      severity: "error",
      from: { path: "(^|/)apps/api/", pathNot: "\\.test\\.tsx?$" },
      to: {
        path: "(^|/)packages/crypto/src/(open|aead-decrypt|local|kms|config|index)\\.ts$",
        reachable: true,
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
      from: {
        pathNot: [
          "\\.test\\.tsx?$",
          "(^|/)packages/engine/src/testing/",
          "(^|/)packages/[a-z]+/test/",
          // WP-17: the dev-only mock API serves the fixture household.
          "(^|/)apps/web/mocks/",
        ],
      },
      to: { path: "(^|/)packages/engine/src/testing/" },
    },
    {
      name: "auth-testing-only-in-tests",
      comment:
        "apps/api/src/auth/testing (the fake Supabase issuer and GoTrue) is for tests only: no production " +
        "module may import it, or a build could ship a verifier that trusts a local key (WP-33).",
      severity: "error",
      from: {
        pathNot: [
          "\\.test\\.tsx?$",
          "(^|/)apps/api/src/auth/testing/",
          // Test helpers that build a test API: files named exactly testing.ts (modules/imports/testing.ts and friends).
          "(^|/)testing\\.ts$",
        ],
      },
      to: { path: "(^|/)apps/api/src/auth/testing/" },
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
      name: "detection-is-pure",
      comment:
        "packages/detection must not import apps or other internal packages (CSV parsing + detection only).",
      severity: "error",
      from: { path: pkg("detection") },
      to: { path: ["(^|/)packages/(?!detection/)", "(^|/)apps/"] },
    },
    {
      name: "detection-no-io",
      comment:
        "packages/detection must not import any Node core module (no I/O, clock, randomness). Tests and the " +
        "synthetic-CSV generator under testing/ may read the fixture.",
      severity: "error",
      from: { path: pkg("detection"), pathNot: ["\\.test\\.ts$", "(^|/)packages/detection/testing/"] },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "detection-npm-allowlist",
      comment: `packages/detection may use only ${DETECTION_NPM_ALLOWLIST.join(", ")} in production code. Extend only with an ADR.`,
      severity: "error",
      from: { path: pkg("detection"), pathNot: ["\\.test\\.ts$", "(^|/)packages/detection/testing/"] },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
        pathNot: `node_modules/(${DETECTION_NPM_ALLOWLIST.map((p) => p.replace("/", "\\/")).join("|")})/`,
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
