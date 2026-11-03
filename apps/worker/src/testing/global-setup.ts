// Vitest global setup for the worker's integration tests: one Postgres container per `vitest run`, created
// from the same docker/postgres/init.sql that docker compose mounts (so roles match local roles) and migrated
// with the real migration runner. Same pattern as apps/api/src/auth/testing/global-setup.ts.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { runMigrations } from "@mp/db";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const INIT_SQL = resolve(REPO_ROOT, "docker/postgres/init.sql");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "packages/db/migrations");
const DB = "moneypilot";

// Passwords from docker/postgres/init.sql (local only).
const PASSWORDS = {
  mp_migrator: "mp_local_migrator",
  mp_api: "mp_local_api",
  mp_worker: "mp_local_worker",
} as const;

declare module "vitest" {
  export interface ProvidedContext {
    apiDatabaseUrl: string;
    workerDatabaseUrl: string;
    /** Superuser. pg-boss creates its own `pgboss` schema with it; fixtures read job tables with it. */
    adminDatabaseUrl: string;
  }
}

/** Colima (no Docker Desktop) needs extra Testcontainers settings; plain Docker (CI) is left alone. */
function configureDocker(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DOCKER_HOST) return;
  const socket = join(homedir(), ".colima", "default", "docker.sock");
  if (!existsSync(socket)) return;
  env.DOCKER_HOST = `unix://${socket}`;
  env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
  env.TESTCONTAINERS_HOST_OVERRIDE ??= "127.0.0.1";
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  configureDocker();
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase(DB)
    .withUsername("postgres")
    .withPassword("mp_test_admin")
    .withCopyFilesToContainer([{ source: INIT_SQL, target: "/docker-entrypoint-initdb.d/01-roles.sql" }])
    .start();
  const url = (role: keyof typeof PASSWORDS): string =>
    `postgres://${role}:${PASSWORDS[role]}@${container.getHost()}:${container.getPort()}/${DB}`;
  try {
    await runMigrations({ databaseUrl: url("mp_migrator"), migrationsDir: MIGRATIONS_DIR });
  } catch (error) {
    await container.stop();
    throw error;
  }
  project.provide("apiDatabaseUrl", url("mp_api"));
  project.provide("workerDatabaseUrl", url("mp_worker"));
  project.provide("adminDatabaseUrl", container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
