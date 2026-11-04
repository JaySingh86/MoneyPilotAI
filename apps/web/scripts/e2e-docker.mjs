/* eslint-disable no-console -- command-line tool */
// Runs the web app's Playwright suite (functional, axe and pixel snapshots) inside the pinned
// official Playwright image, so baselines are generated and checked on the same Linux Chromium CI
// uses. Mirrors packages/ui/scripts/visual-docker.mjs.
//
//   node scripts/e2e-docker.mjs test     verify against the committed baselines
//   node scripts/e2e-docker.mjs update   regenerate the baselines
//
// Uses plain `docker run`. With Colima set DOCKER_HOST to its socket, for example
// unix:///Users/<you>/.colima/default/docker.sock.
//
// ARCHITECTURE OF THE BASELINES (arm64 vs x86): the committed baselines were rendered on arm64
// (Apple Silicon, Colima, linux/arm64 image). Chromium renders text and anti-aliasing slightly
// differently on x86, so a baseline made on one architecture can fail on the other at the 0.2 %
// threshold. CI therefore runs the `visual` and `web-e2e` jobs on an arm64 runner
// (`ubuntu-24.04-arm`, see .github/workflows/ci.yml). If CI moves to x86, regenerate the baselines
// there (VISUAL_PLATFORM=linux/amd64 on a machine that can run it natively, or in CI itself) and
// commit them, for packages/ui and apps/web both.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "test" && mode !== "update") {
  console.error("usage: e2e-docker.mjs test|update");
  process.exit(2);
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

const playwrightVersion = webPackage.devDependencies["@playwright/test"];
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
tar -C /src --exclude=node_modules --exclude=.git --exclude=.claude --exclude=.turbo --exclude=.next \\
  --exclude=test-results --exclude=playwright-report -cf - . | tar -C /work -xf -
cd /work
corepack enable
corepack prepare pnpm@${pnpmVersion} --activate
pnpm install --frozen-lockfile --ignore-scripts --filter @mp/web...
cd apps/web
status=0
pnpm exec playwright test${update} || status=$?
# Hand results back to the checkout: baselines on update, diffs on failure.
mkdir -p /src/apps/web/e2e
if [ "${mode}" = "update" ]; then
  rm -rf /src/apps/web/e2e/__screenshots__
  cp -R e2e/__screenshots__ /src/apps/web/e2e/__screenshots__
fi
rm -rf /src/apps/web/test-results
[ -d test-results ] && cp -R test-results /src/apps/web/test-results
exit $status
`;

// The committed baselines are arm64 renders (see the note above). Set VISUAL_PLATFORM=linux/amd64
// to render x86 ones instead (slow under emulation, and Chromium may crash without Rosetta).
const platform = process.env.VISUAL_PLATFORM ?? "linux/arm64";

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
console.log(`docker run ${image} (${mode}, ${platform})`);
const result = spawnSync("docker", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
