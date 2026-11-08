// Global setup for `pnpm test:supabase-compat` (WP-32): the Supabase Postgres image, bootstrapped with
// packages/db/supabase/bootstrap.sql exactly as the owner runs it, then every migration as mp_migrator.
// It provides the same app-role URLs as global-setup.ts so the RLS suite runs unchanged.
import pg from "pg";
import type { TestProject } from "vitest/node";
import { runBootstrap, type BootstrapRole } from "../../src/cli/bootstrap-lib";
import { runMigrations } from "../../src/migrate";
import { configureDockerForTestcontainers } from "./docker-env";
import { MIGRATIONS_DIR } from "./paths";

/**
 * Pinned to the Postgres major Supabase uses for new projects (17). Bump together with the hosted project's
 * version (Project Settings -> Infrastructure). Pulled from Supabase's public ECR mirror of supabase/postgres.
 */
export const SUPABASE_POSTGRES_IMAGE =
  "public.ecr.aws/supabase/postgres:17.11.0.011@sha256:7bd84e6a1d5322c7b864b9751873a0ac50f48df3f20a776e88114eadb2948fc0";

const ADMIN_PASSWORD = "mp_test_admin";
// Test-only passwords for a throwaway container.
const PASSWORDS: Record<BootstrapRole, string> = {
  mp_migrator: "mp_test_migrator",
  mp_api: "mp_test_api",
  mp_worker: "mp_test_worker",
  mp_queue: "mp_test_queue",
};

declare module "vitest" {
  export interface ProvidedContext {
    /** Supabase `postgres` user. Only the compatibility tests receive it. */
    supabaseAdminUrl: string;
    /** mp_migrator on the bootstrapped database. */
    supabaseMigratorUrl: string;
    /** Test passwords by role, to prove a re-run of the bootstrap leaves them alone. */
    supabaseRolePasswords: Record<BootstrapRole, string>;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  configureDockerForTestcontainers();
  const { GenericContainer, Wait } = await import("testcontainers");

  const container = await new GenericContainer(SUPABASE_POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_PASSWORD: ADMIN_PASSWORD })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(240_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = (user: string, password: string): string =>
    `postgres://${user}:${password}@${host}:${port}/postgres`;

  try {
    await waitUntilAcceptingConnections(url("postgres", ADMIN_PASSWORD));
    await runBootstrap({ adminUrl: url("postgres", ADMIN_PASSWORD), passwords: PASSWORDS });
    await runMigrations({
      databaseUrl: url("mp_migrator", PASSWORDS.mp_migrator),
      migrationsDir: MIGRATIONS_DIR,
    });
  } catch (error) {
    await container.stop();
    throw error;
  }

  project.provide("databaseUrl", url("mp_api", PASSWORDS.mp_api));
  project.provide("workerDatabaseUrl", url("mp_worker", PASSWORDS.mp_worker));
  project.provide("queueDatabaseUrl", url("mp_queue", PASSWORDS.mp_queue));
  project.provide("supabaseAdminUrl", url("postgres", ADMIN_PASSWORD));
  project.provide("supabaseMigratorUrl", url("mp_migrator", PASSWORDS.mp_migrator));
  project.provide("supabaseRolePasswords", PASSWORDS);

  return async () => {
    await container.stop();
  };
}

/** The image restarts Postgres once during init; the second "ready" line can precede the first real login. */
async function waitUntilAcceptingConnections(connectionString: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError;
}
