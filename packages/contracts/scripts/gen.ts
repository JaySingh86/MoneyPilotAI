// `pnpm contracts:gen` writes the OpenAPI document and client types; `pnpm contracts:gen --check` (CI)
// exits 1 when the committed files differ from what the API generates now.
// `--root <dir>` compares/writes against another copy of packages/contracts (tests).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONTRACTS_ROOT, findDrift, generateArtifacts, readApiDocument } from "./generate";

const args = process.argv.slice(2);
const check = args.includes("--check");
const rootFlag = args.indexOf("--root");
const rootArg = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
const root = rootArg ? resolve(rootArg) : CONTRACTS_ROOT;
const artifacts = await generateArtifacts(readApiDocument());
const drifted = await findDrift(artifacts, root);

if (check) {
  if (drifted.length > 0) {
    process.stderr.write(
      `contracts:gen --check: generated contracts are out of date:\n${drifted
        .map((p) => `  packages/contracts/${p}`)
        .join("\n")}\nRun \`pnpm contracts:gen\` and commit the result.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("contracts:gen --check: up to date.\n");
} else {
  for (const artifact of artifacts) {
    if (!drifted.includes(artifact.path)) continue;
    const target = join(root, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
  }
  process.stdout.write(
    drifted.length > 0
      ? `contracts:gen: wrote ${drifted.map((p) => `packages/contracts/${p}`).join(", ")}\n`
      : "contracts:gen: already up to date.\n",
  );
}
