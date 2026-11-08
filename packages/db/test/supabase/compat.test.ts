// WP-32 / ADR-020: what the bootstrap and the migrations must leave behind on a Supabase database. The
// cross-household behaviour itself is covered by the unchanged test/rls suite, which runs next to this file.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runBootstrap } from "../../src/cli/bootstrap-lib";

const API_ROLES = ["anon", "authenticated", "service_role"] as const;
let admin: pg.Pool;
const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  (await admin.query<T>(text, values)).rows;

beforeAll(() => {
  admin = new pg.Pool({ connectionString: inject("supabaseAdminUrl"), max: 2 });
});
afterAll(async () => {
  await admin.end();
});

describe("roles", () => {
  it("none of ours is a superuser, bypasses RLS, or can create roles or databases", async () => {
    const rows = await q<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles
        where rolname in ('mp_migrator','mp_api','mp_worker','mp_queue','mp_analytics') order by rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      "mp_analytics",
      "mp_api",
      "mp_migrator",
      "mp_queue",
      "mp_worker",
    ]);
    for (const r of rows) {
      expect(r.rolsuper, r.rolname).toBe(false);
      expect(r.rolbypassrls, r.rolname).toBe(false);
      expect(r.rolcreaterole, r.rolname).toBe(false);
      expect(r.rolcreatedb, r.rolname).toBe(false);
      expect(r.rolcanlogin, r.rolname).toBe(r.rolname !== "mp_analytics");
    }
  });
});

describe("migrations as mp_migrator, which does not own the database", () => {
  it("the migrator owns our tables, not the database or the public schema", async () => {
    const [db] = await q<{ owner: string }>(
      "select datdba::regrole::text as owner from pg_database where datname = current_database()",
    );
    expect(db?.owner).toBe("postgres");
    const [schema] = await q<{ owner: string }>(
      "select nspowner::regrole::text as owner from pg_namespace where nspname = 'public'",
    );
    expect(schema?.owner).not.toBe("mp_migrator");
    const owners = await q<{ owner: string }>(
      "select distinct tableowner as owner from pg_tables where schemaname = 'public'",
    );
    expect(owners.map((o) => o.owner)).toEqual(["mp_migrator"]);
    const [boss] = await q<{ owner: string }>(
      "select nspowner::regrole::text as owner from pg_namespace where nspname = 'pgboss'",
    );
    expect(boss?.owner).toBe("mp_migrator");
  });

  it("citext lives in public (as on a vanilla database) and pgcrypto in extensions", async () => {
    const rows = await q<{ extname: string; nspname: string }>(
      "select extname, nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where extname in ('citext','pgcrypto') order by extname",
    );
    expect(rows).toEqual([
      { extname: "citext", nspname: "public" },
      { extname: "pgcrypto", nspname: "extensions" },
    ]);
    const [col] = await q<{ type: string }>(
      "select format_type(a.atttypid, null) as type from pg_attribute a where a.attrelid = 'public.users'::regclass and a.attname = 'email'",
    );
    expect(col?.type).toBe("citext");
  });
});

describe("the Supabase Data API roles", () => {
  it("have no usage on public and no privilege on any of our tables, sequences or functions", async () => {
    for (const role of API_ROLES) {
      const [schema] = await q<{ ok: boolean }>("select has_schema_privilege($1, 'public', 'USAGE') as ok", [
        role,
      ]);
      expect(schema?.ok, `${role} usage on public`).toBe(false);
      const tables = await q<{ n: string }>(
        `select format('%I.%I', schemaname, tablename) as n from pg_tables
          where schemaname in ('public','pgboss') and (
            has_table_privilege($1, format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))`,
        [role],
      );
      expect(tables, `${role} table privileges`).toEqual([]);
      const functions = await q<{ n: string }>(
        `select p.oid::regprocedure::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','pgboss') and has_function_privilege($1, p.oid, 'EXECUTE')
            and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
        [role],
      );
      expect(functions, `${role} function privileges`).toEqual([]);
    }
  });

  it("cannot call one of our SECURITY DEFINER functions", async () => {
    // SET ROLE needs membership; the admin has it for the Supabase API roles.
    const client = await admin.connect();
    try {
      for (const role of API_ROLES) {
        await client.query(`set role ${role}`);
        await expect(client.query("select public.app_user_id()")).rejects.toMatchObject({ code: "42501" });
        await client.query("reset role");
      }
    } finally {
      client.release();
    }
  });
});

async function expectLogin(role: string, password: string, works: boolean): Promise<void> {
  const url = new URL(inject("supabaseAdminUrl"));
  url.username = role;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  if (works) {
    await client.connect();
    await client.end();
  } else {
    await expect(client.connect()).rejects.toMatchObject({ code: "28P01" });
  }
}

describe("the migrator's rights", () => {
  it("has no database-level CREATE, and still ran every migration (pgboss came from the bootstrap)", async () => {
    const [row] = await q<{ ok: boolean }>(
      "select has_database_privilege('mp_migrator', current_database(), 'CREATE') as ok",
    );
    expect(row?.ok).toBe(false);
    const [boss] = await q<{ owner: string }>(
      "select nspowner::regrole::text as owner from pg_namespace where nspname = 'pgboss'",
    );
    expect(boss?.owner).toBe("mp_migrator");
  });
});

describe("the bootstrap script", () => {
  it("is idempotent: a second run changes no password and keeps the lockdown", async () => {
    const passwords = inject("supabaseRolePasswords");
    const result = await runBootstrap({ adminUrl: inject("supabaseAdminUrl") });
    expect(result.created).toEqual([]);
    expect(result.passwords).toEqual({});
    // The roles still log in with the passwords set by the first run.
    for (const [role, password] of Object.entries(passwords)) {
      const url = new URL(inject("supabaseAdminUrl"));
      url.username = role;
      url.password = password;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      await client.end();
    }
    const [row] = await q<{ ok: boolean }>("select has_schema_privilege('anon', 'public', 'USAGE') as ok");
    expect(row?.ok).toBe(false);
  });

  it("refuses a pre-existing role that is a member of another role, before it changes any password", async () => {
    const passwords = inject("supabaseRolePasswords");
    await admin.query("grant pg_read_all_data to mp_analytics");
    try {
      await expect(
        runBootstrap({ adminUrl: inject("supabaseAdminUrl"), passwords: { mp_api: "must-not-be-set" } }),
      ).rejects.toThrow(/member of another role/);
      await expectLogin("mp_api", passwords.mp_api, true);
      await expectLogin("mp_api", "must-not-be-set", false);
    } finally {
      await admin.query("revoke pg_read_all_data from mp_analytics");
    }
  });

  it("refuses a pre-existing role with REPLICATION (or any elevated attribute), before it changes any password", async () => {
    const passwords = inject("supabaseRolePasswords");
    await admin.query("alter role mp_analytics replication");
    try {
      await expect(
        runBootstrap({ adminUrl: inject("supabaseAdminUrl"), passwords: { mp_api: "must-not-be-set" } }),
      ).rejects.toThrow(/REPLICATION/);
      await expectLogin("mp_api", passwords.mp_api, true);
      await expectLogin("mp_api", "must-not-be-set", false);
    } finally {
      await admin.query("alter role mp_analytics noreplication");
    }
  });

  it("refuses to run as one of our own roles", async () => {
    const url = new URL(inject("supabaseAdminUrl"));
    url.username = "mp_api";
    url.password = inject("supabaseRolePasswords").mp_api;
    await expect(runBootstrap({ adminUrl: url.toString() })).rejects.toThrow(/postgres/);
  });
});
