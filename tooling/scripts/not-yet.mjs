// Placeholder for commands whose implementation arrives in a later work package.
// Usage: not-yet.mjs <command> <WP> [sentinel-path] [flags...]
// Exits 0 so CI stays green until the owning WP lands. Once the sentinel path exists, the WP has
// started and this placeholder must be replaced, so it fails instead of silently passing a CI gate.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [command = "command", wp = "a later work package", sentinel, ...rest] = process.argv.slice(2);
const sentinelIsFlag = sentinel?.startsWith("-");
const flags = (sentinelIsFlag ? [sentinel, ...rest] : rest).join(" ");
const label = `${command}${flags ? ` ${flags}` : ""}`;

if (sentinel && !sentinelIsFlag && existsSync(resolve(process.cwd(), sentinel))) {
  console.error(
    `${label}: ${sentinel} exists, so ${wp} has started, but this command is still a placeholder. Replace the script.`,
  );
  process.exit(1);
}
console.log(`${label}: not implemented yet, arrives in ${wp} (docs/agents/WORK_PLAN.md).`);
