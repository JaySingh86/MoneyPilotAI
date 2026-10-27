// pnpm db:migrate — applies pending migrations as mp_migrator (MIGRATOR_DATABASE_URL).
import { resolve } from "node:path";
import { runMigrations } from "../migrate";
import { fail, PACKAGE_ROOT, requireEnv, say } from "./env";

try {
  const result = await runMigrations({
    databaseUrl: requireEnv("MIGRATOR_DATABASE_URL"),
    migrationsDir: resolve(PACKAGE_ROOT, "migrations"),
  });
  for (const name of result.applied) say(`applied ${name}`);
  say(`${result.applied.length} applied, ${result.alreadyApplied.length} already applied`);
} catch (error) {
  fail(error);
}
