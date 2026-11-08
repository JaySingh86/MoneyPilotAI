// pnpm dev:live — api (:4000), worker and web (:3100) against `.env.local`, NOT in mock mode (WP-32, ADR-020).
// Loads `.env.local` once and hands the environment to the three processes. Stops them all when one exits or on
// Ctrl+C. `pnpm dev` stays the mock-mode command (MSW and a fake session; no database needed).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { envFor, missingKeys } from "./dev-live-env.mjs";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env.local");
if (!existsSync(envFile)) {
  process.stderr.write(
    "No .env.local. Copy .env.example to .env.local and fill it in (docs/runbooks/supabase-setup.md).\n",
  );
  process.exit(1);
}
process.loadEnvFile(envFile);

// The one-time bootstrap URL must not outlive that step, and is never handed to a child process.
delete process.env.SUPABASE_ADMIN_URL;
const missing = missingKeys(process.env);
if (missing.length > 0) {
  process.stderr.write(`.env.local is missing ${missing.join(", ")}.\n`);
  process.exit(1);
}

const commands = [
  ["api", ["--filter", "@mp/api", "start"]],
  ["worker", ["--filter", "@mp/worker", "start"]],
  ["web", ["--filter", "@mp/web", "dev:live"]],
];
const children = commands.map(([name, args]) => {
  // Each process gets only its own settings (dev-live-env.mjs), never the whole of .env.local.
  const child = spawn("pnpm", args, {
    cwd: root,
    env: envFor(name, process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line) out.write(`[${name}] ${line}\n`);
    });
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stderr.write(`[${name}] exited with ${code ?? "a signal"}; stopping the others\n`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
