import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

/** Reads a required env var, loading the repo's .env.local first if present (see .env.example). */
export function requireEnv(name: string): string {
  const local = resolve(REPO_ROOT, ".env.local");
  if (!process.env[name] && existsSync(local)) process.loadEnvFile(local);
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local or export it.`);
  return value;
}

/** CLI output. Messages carry file names and counts only, never row data. */
export function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function fail(error: unknown): never {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
