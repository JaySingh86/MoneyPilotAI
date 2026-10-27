import { resolve } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/migrate";
import { configureDockerForTestcontainers } from "./docker-env";
import { MIGRATIONS_DIR, REPO_ROOT } from "./paths";

/** The same file docker compose mounts, so test roles match local roles exactly. */
const INIT_SQL = resolve(REPO_ROOT, "docker/postgres/init.sql");

const DB = "moneypilot";
/** Vitest project name of `pnpm test:rls` (vitest.rls.config.ts). */
export const RLS_PROJECT = "rls";
/** Extra empty databases for migration-runner tests, prepared the way init.sql prepares `moneypilot`. */
const SCRATCH_DBS = ["moneypilot_scratch", "moneypilot_runner"] as const;

// Passwords from docker/postgres/init.sql (local only).
const ROLE_PASSWORDS = {
  mp_migrator: "mp_local_migrator",
  mp_api: "mp_local_api",
  mp_worker: "mp_local_worker",
} as const;

declare module "vitest" {
  export interface ProvidedContext {
    /** mp_api (RLS via app.user_id). */
    databaseUrl: string;
    /** mp_worker (RLS via app.household_id). */
    workerDatabaseUrl: string;
    /** mp_migrator on the migrated DB. Schema metadata only, never for RLS assertions. */
    migratorDatabaseUrl: string;
    /** mp_migrator URLs for the empty scratch databases. */
    scratchMigratorUrls: Record<(typeof SCRATCH_DBS)[number], string>;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  configureDockerForTestcontainers();
  // Import after the env is configured: testcontainers reads it when the first client is created.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");

  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase(DB)
    .withUsername("postgres")
    .withPassword("mp_test_admin")
    .withCopyFilesToContainer([{ source: INIT_SQL, target: "/docker-entrypoint-initdb.d/01-roles.sql" }])
    .start();

  const host = container.getHost();
  const port = container.getPort();
  const url = (role: keyof typeof ROLE_PASSWORDS, db: string = DB): string =>
    `postgres://${role}:${ROLE_PASSWORDS[role]}@${host}:${port}/${db}`;

  try {
    // Superuser is used here only, to create the scratch databases. Tests never receive it.
    const admin = new pg.Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    try {
      for (const db of SCRATCH_DBS) {
        await admin.query(`CREATE DATABASE ${db} OWNER mp_migrator`);
        const scoped = new pg.Client({
          connectionString: container.getConnectionUri().replace(/\/[^/]+$/, `/${db}`),
        });
        await scoped.connect();
        try {
          await scoped.query(`ALTER SCHEMA public OWNER TO mp_migrator;
            REVOKE ALL ON SCHEMA public FROM PUBLIC;
            GRANT USAGE ON SCHEMA public TO mp_api, mp_worker, mp_analytics;`);
        } finally {
          await scoped.end();
        }
      }
    } finally {
      await admin.end();
    }

    await runMigrations({ databaseUrl: url("mp_migrator"), migrationsDir: MIGRATIONS_DIR });
  } catch (error) {
    await container.stop();
    throw error;
  }

  project.provide("databaseUrl", url("mp_api"));
  project.provide("workerDatabaseUrl", url("mp_worker"));
  // `pnpm test:rls` (project "rls") never receives a migrator URL: its tests connect as app roles only.
  if (project.name !== RLS_PROJECT) {
    project.provide("migratorDatabaseUrl", url("mp_migrator"));
    project.provide("scratchMigratorUrls", {
      moneypilot_scratch: url("mp_migrator", "moneypilot_scratch"),
      moneypilot_runner: url("mp_migrator", "moneypilot_runner"),
    });
  }

  return async () => {
    await container.stop();
  };
}
