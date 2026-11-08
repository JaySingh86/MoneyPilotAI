// Startup checks for the pg-boss connection (security review M2, Q-105). pg-boss owns a schema and runs
// DDL, so its connection is more powerful than the job handlers' `mp_worker` one. In production it must be
// explicitly configured and must not be a role that could read around row-level security.
import { pgConfig } from "@mp/db";
import pg from "pg";

export class StartupCheckError extends Error {
  override readonly name = "StartupCheckError";
}

export interface RoleInfo {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * The pg-boss connection string. Production requires `PGBOSS_DATABASE_URL`; elsewhere it falls back to
 * the migrator URL so local development works with one `docker compose` database.
 */
export function resolveBossUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.PGBOSS_DATABASE_URL;
  if (explicit) return explicit;
  if (env.NODE_ENV === "production") {
    throw new StartupCheckError("PGBOSS_DATABASE_URL must be set in production.");
  }
  const fallback = env.MIGRATOR_DATABASE_URL;
  if (!fallback) {
    throw new StartupCheckError("PGBOSS_DATABASE_URL (or MIGRATOR_DATABASE_URL locally) is not set.");
  }
  return fallback;
}

/** The queue role may neither be a superuser, bypass RLS, nor be the migrator (which owns every table). */
export function assertQueueRole(role: RoleInfo): void {
  if (role.rolsuper) {
    throw new StartupCheckError(`Role ${role.rolname} is a superuser; refusing to run jobs with it.`);
  }
  if (role.rolbypassrls) {
    throw new StartupCheckError(
      `Role ${role.rolname} bypasses row-level security; refusing to run jobs with it.`,
    );
  }
  if (role.rolname === "mp_migrator") {
    throw new StartupCheckError("The queue connection must not use mp_migrator, which owns the schema.");
  }
}

export async function readConnectionRole(connectionString: string): Promise<RoleInfo> {
  const client = new pg.Client(pgConfig(connectionString));
  await client.connect();
  try {
    const res = await client.query<RoleInfo>(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    const role = res.rows[0];
    if (!role) throw new StartupCheckError("Could not read the queue connection's role.");
    return role;
  } finally {
    await client.end();
  }
}

/** Resolves the URL and, in production, checks the role it connects as. */
export async function checkBossConnection(env: NodeJS.ProcessEnv): Promise<string> {
  const url = resolveBossUrl(env);
  if (env.NODE_ENV === "production") assertQueueRole(await readConnectionRole(url));
  return url;
}
