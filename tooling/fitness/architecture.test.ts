import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { cruise } from "dependency-cruiser";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const depConfig = require("../../.dependency-cruiser.cjs");
const FIX = "tooling/fitness/__fixtures__";

async function violationsIn(paths: string[]): Promise<string[]> {
  const { enhancedResolveOptions, exclude, doNotFollow } = depConfig.options;
  const onFixtures = paths.some((p) => p.includes("__fixtures__"));
  const result = await cruise(
    paths,
    {
      ruleSet: { forbidden: depConfig.forbidden },
      validate: true,
      doNotFollow,
      // Same excludes as the real config, except fixtures are cruised when asked for explicitly.
      exclude: { path: onFixtures ? exclude.path.filter((p: string) => p !== "__fixtures__") : exclude.path },
      tsPreCompilationDeps: true,
      outputType: "json",
    },
    enhancedResolveOptions,
  );
  const output = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
  return output.summary.violations.map((v: { rule: { name: string } }) => v.rule.name);
}

describe("dependency rules (ARCHITECTURE §3)", () => {
  it("rejects apps/web importing packages/db", async () => {
    expect(await violationsIn([`${FIX}/apps/web`])).toContain("web-boundaries");
  });

  it("rejects an engine that does I/O, imports another package or uses a non-allowlisted npm package", async () => {
    const rules = await violationsIn([`${FIX}/packages/engine`]);
    expect(rules).toContain("engine-is-pure");
    expect(rules).toContain("engine-no-io");
    expect(rules).toContain("engine-npm-allowlist");
  });

  it("rejects adapters importing each other", async () => {
    expect(await violationsIn([`${FIX}/packages/ai/src/imports-db.ts`])).toContain("adapters-isolated");
  });

  it("lets apps/api seal tokens with crypto/encrypt", async () => {
    expect(await violationsIn([`${FIX}/apps/api/imports-encrypt.ts`])).toEqual([]);
  });

  it("rejects apps/api decrypting tokens or using the extraction route", async () => {
    const rules = await violationsIn([`${FIX}/apps/api/imports-decrypt-and-extract.ts`]);
    expect(rules).toContain("only-worker-touches-secrets");
    expect(rules).toContain("api-ai-explain-ask-only");
  });

  it("rejects production code importing the engine test fixtures", async () => {
    expect(await violationsIn([`${FIX}/apps/worker/imports-engine-testing.ts`])).toContain(
      "engine-testing-only-in-tests",
    );
  });

  it("finds no violations in the real codebase", async () => {
    expect(await violationsIn(["apps", "packages"])).toEqual([]);
  });
});

describe("lint rules (CLAUDE.md hard rules)", () => {
  const eslint = new ESLint();
  const ruleIds = async (code: string, filePath: string) => {
    const [res] = await eslint.lintText(code, { filePath });
    return res?.messages.map((m) => m.ruleId) ?? [];
  };

  it("rejects hex colors in web UI code", async () => {
    expect(await ruleIds('export const c = { color: "#12201B" };\n', "apps/web/app/fixture.tsx")).toContain(
      "no-restricted-syntax",
    );
  });

  it("rejects raw font sizes in UI code, including quoted keys", async () => {
    expect(await ruleIds("export const s = { fontSize: 14 };\n", "packages/ui/src/fixture.tsx")).toContain(
      "no-restricted-syntax",
    );
    expect(
      await ruleIds('export const s = { "font-size": "14px" };\n', "packages/ui/src/fixture.tsx"),
    ).toContain("no-restricted-syntax");
  });

  it("rejects console logging anywhere in source", async () => {
    expect(await ruleIds('console.log("amount", 68400);\n', "apps/api/src/fixture.ts")).toContain(
      "no-console",
    );
  });

  it("allows hex colors outside UI code", async () => {
    expect(await ruleIds('export const c = "#12201B";\n', "apps/api/src/fixture.ts")).not.toContain(
      "no-restricted-syntax",
    );
  });

  it("rejects clocks and randomness in the engine (hard rule 2, ADR-005)", async () => {
    const file = "packages/engine/src/fixture.ts";
    expect(await ruleIds("export const t = Date.now();\n", file)).toContain("no-restricted-properties");
    expect(await ruleIds("export const r = Math.random();\n", file)).toContain("no-restricted-properties");
    expect(await ruleIds("export const d = new Date();\n", file)).toContain("no-restricted-syntax");
  });
});
