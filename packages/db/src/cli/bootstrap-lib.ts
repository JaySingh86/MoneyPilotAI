// Runs packages/db/supabase/bootstrap.sql as the Supabase admin user (ADR-020). Shared by the CLI and the
// compatibility test. Passwords are generated here, handed to the session with set_config and never logged.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { pgConfig, urlForRole } from "../connection";
import { PACKAGE_ROOT } from "./env";

export const BOOTSTRAP_ROLES = ["mp_migrator", "mp_api", "mp_worker", "mp_queue"] as const;
export type BootstrapRole = (typeof BOOTSTRAP_ROLES)[number];

export interface BootstrapOptions {
  /** Connection string of the Supabase admin user (`postgres`), usually through the session pooler. */
  adminUrl: string;
  /** Generate and set a new password for roles that already exist too. Default: only for new roles. */
  rotate?: boolean;
  /** Fixed passwords, for tests only. Missing roles get a generated one when they are new. */
  passwords?: Partial<Record<BootstrapRole, string>>;
}

export interface BootstrapResult {
  /** Roles whose password was set in this run. Roles left out keep their old password. */
  passwords: Partial<Record<BootstrapRole, string>>;
  created: BootstrapRole[];
}

export const newPassword = (): string => randomBytes(24).toString("base64url");

export async function runBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const sql = await readFile(resolve(PACKAGE_ROOT, "supabase/bootstrap.sql"), "utf8");
  const client = new pg.Client(pgConfig(options.adminUrl));
  await client.connect();
  try {
    const me = await client.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean }>(
      "select rolname, rolsuper, rolcreaterole from pg_roles where rolname = current_user",
    );
    const admin = me.rows[0];
    if (!admin || !(admin.rolsuper || admin.rolcreaterole)) {
      throw new Error(
        "SUPABASE_ADMIN_URL must connect as the `postgres` user (it needs CREATEROLE). The `mp_*` roles cannot bootstrap themselves.",
      );
    }
    const existing = new Set(
      (
        await client.query<{ rolname: string }>("select rolname from pg_roles where rolname = any($1)", [
          [...BOOTSTRAP_ROLES],
        ])
      ).rows.map((r) => r.rolname),
    );
    const created = BOOTSTRAP_ROLES.filter((r) => !existing.has(r));
    const passwords: Partial<Record<BootstrapRole, string>> = {};
    for (const role of BOOTSTRAP_ROLES) {
      const fixed = options.passwords?.[role];
      if (fixed) passwords[role] = fixed;
      else if (!existing.has(role) || options.rotate) passwords[role] = newPassword();
    }

    // Session-level settings so the passwords never appear in the script text. `false` = for the session.
    for (const role of BOOTSTRAP_ROLES) {
      await client.query("select set_config($1, $2, false)", [`mp.pw_${role}`, passwords[role] ?? ""]);
    }
    await client.query(sql);
    for (const role of BOOTSTRAP_ROLES) {
      await client.query("select set_config($1, '', false)", [`mp.pw_${role}`]);
    }
    return { passwords, created };
  } finally {
    await client.end();
  }
}

/** The `.env.local` lines for the roles whose password was just set. Contains secrets: print, never log. */
export function envLines(adminUrl: string, passwords: BootstrapResult["passwords"]): string[] {
  const names: Record<BootstrapRole, string> = {
    mp_migrator: "MIGRATOR_DATABASE_URL",
    mp_api: "DATABASE_URL",
    mp_worker: "WORKER_DATABASE_URL",
    mp_queue: "PGBOSS_DATABASE_URL",
  };
  const lines: string[] = [];
  for (const role of BOOTSTRAP_ROLES) {
    const pw = passwords[role];
    if (pw) lines.push(`${names[role]}=${urlForRole(adminUrl, role, pw)}`);
  }
  return lines;
}
