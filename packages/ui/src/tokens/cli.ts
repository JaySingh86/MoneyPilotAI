// `tokens:gen` writes tokens.generated.ts from design/tokens.json.
// `tokens:check` fails if design/tokens.css diverges from design/tokens.json, or if
// tokens.generated.ts is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkTokens, renderTokensModule } from "./build";

const root = new URL("../../../../", import.meta.url);
const jsonPath = new URL("design/tokens.json", root);
const cssPath = new URL("design/tokens.css", root);
const generatedPath = new URL("tokens.generated.ts", import.meta.url);

const json: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
const mode = process.argv[2];

if (mode === "gen") {
  writeFileSync(generatedPath, renderTokensModule(json));
  process.stdout.write(`Wrote ${fileURLToPath(generatedPath)}\n`);
} else if (mode === "check") {
  const problems = checkTokens(json, readFileSync(cssPath, "utf8"));
  if (readFileSync(generatedPath, "utf8") !== renderTokensModule(json)) {
    problems.push("tokens.generated.ts is stale: run `pnpm --filter @mp/ui tokens:gen`");
  }
  if (problems.length > 0) {
    process.stderr.write(`Design tokens diverge:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("design/tokens.css matches design/tokens.json; generated tokens are current.\n");
} else {
  process.stderr.write("Usage: cli.ts gen|check\n");
  process.exit(2);
}
