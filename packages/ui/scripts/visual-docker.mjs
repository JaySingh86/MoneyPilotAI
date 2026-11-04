/* eslint-disable no-console -- command-line tool */
// Runs the Playwright visual tests inside the pinned official Playwright image, so baselines are
// generated and checked on the same Linux Chromium that CI uses.
//
//   node scripts/visual-docker.mjs test     verify against the committed baselines
//   node scripts/visual-docker.mjs update   regenerate the baselines
//
// Uses plain `docker run` (no compose). With Colima set DOCKER_HOST to its socket, for example
// unix:///Users/<you>/.colima/default/docker.sock. The image is linux/amd64 like GitHub's
// ubuntu runners, so an Apple Silicon Mac runs it under emulation (slower, same pixels).
// Storybook is built on the host first: the static output is platform independent, and esbuild
// (a Go binary) does not survive amd64 emulation. The container only serves it and runs Chromium.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "test" && mode !== "update") {
  console.error("usage: visual-docker.mjs test|update");
  process.exit(2);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const uiPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

const playwrightVersion = uiPackage.devDependencies["@playwright/test"];
if (!/^\d+\.\d+\.\d+$/.test(playwrightVersion)) {
  console.error(`@playwright/test must be pinned to an exact version, got ${playwrightVersion}`);
  process.exit(2);
}
// Keep this tag in step with the container image in .github/workflows/ci.yml.
const image = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`;
const pnpmVersion = rootPackage.packageManager.replace(/^pnpm@/, "");

const update = mode === "update" ? " --update-snapshots" : "";
const script = `
set -euo pipefail
mkdir -p /work
tar -C /src --exclude=node_modules --exclude=.git --exclude=.claude --exclude=.turbo \\
  --exclude=test-results --exclude=playwright-report -cf - . | tar -C /work -xf -
cd /work
corepack enable
corepack prepare pnpm@${pnpmVersion} --activate
# No install scripts: nothing here needs a build, and esbuild's check would run a Go binary.
pnpm install --frozen-lockfile --ignore-scripts --filter @mp/ui...
status=0
pnpm --filter @mp/ui exec playwright test${update} || status=$?
# Hand results back to the checkout: baselines on update, diffs on failure.
mkdir -p /src/packages/ui/visual
if [ "${mode}" = "update" ]; then
  rm -rf /src/packages/ui/visual/__screenshots__
  cp -R packages/ui/visual/__screenshots__ /src/packages/ui/visual/__screenshots__
fi
rm -rf /src/packages/ui/test-results
[ -d packages/ui/test-results ] && cp -R packages/ui/test-results /src/packages/ui/test-results
exit $status
`;

// linux/amd64 matches GitHub's ubuntu runners. Chromium crashes under qemu amd64 emulation (Colima
// on Apple Silicon without Rosetta); set VISUAL_PLATFORM=linux/arm64 to run the same pinned
// image natively there. Pixels can differ slightly between architectures: baselines meant for CI
// should be generated on amd64 (a Linux x86 machine, or Rosetta-enabled Docker).
//
// BASELINE ARCHITECTURE (WP-17 note): the committed baselines are arm64 renders (VISUAL_PLATFORM=
// linux/arm64 on Apple Silicon). CI therefore runs the `visual` and `web-e2e` jobs on an arm64
// runner (`ubuntu-24.04-arm`). If CI must run on x86, regenerate the baselines on x86 first.
const platform = process.env.VISUAL_PLATFORM ?? "linux/arm64";

const build = spawnSync("pnpm", ["--filter", "@mp/ui", "build-storybook"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const args = [
  "run",
  "--rm",
  "--platform",
  platform,
  "--ipc=host",
  "-e",
  "CI=1",
  "-e",
  "HOME=/root",
  "-v",
  `${repoRoot}:/src`,
  image,
  "bash",
  "-c",
  script,
];
console.log(`docker run ${image} (${mode}) from ${here}`);
const result = spawnSync("docker", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
