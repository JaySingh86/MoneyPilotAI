// Meta-tests for the RLS harness itself (ADR-003, ARCHITECTURE §8). Connects as mp_api / mp_worker
// only. The "new table without a case" meta-test needs the schema owner to create a table, so it lives
// in test/integration/rls-harness-meta.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MIGRATIONS_TABLE } from "../../src/migrate";
import { householdTableCases } from "./cases";
import { checkCoverage, listHouseholdTables } from "./coverage";

const APP_ROLES = ["mp_api", "mp_worker"] as const;
const covered = householdTableCases.map((c) => c.table);

let apiClient: pg.Client;
beforeAll(async () => {
  apiClient = new pg.Client({ connectionString: inject("databaseUrl") });
  await apiClient.connect();
});
afterAll(async () => {
  await apiClient.end();
});

describe("checkCoverage", () => {
  it("reports tables without a case and cases without a table", () => {
    expect(checkCoverage(["a", "b", "c"], ["a", "c", "gone"])).toEqual({ missing: ["b"], stale: ["gone"] });
    expect(checkCoverage(["a"], ["a"])).toEqual({ missing: [], stale: [] });
  });
});

describe("cross-tenant coverage", () => {
  it("every table with household_id has a cross-household test case", async () => {
    const report = checkCoverage(await listHouseholdTables(apiClient), covered);
    expect(report.missing, "add a case to test/rls/cases.ts for these tables").toEqual([]);
    expect(report.stale, "remove cases for tables that no longer exist").toEqual([]);
  });
});

describe("RLS posture of every table", () => {
  it("every table in public has RLS enabled and forced", async () => {
    const res = await apiClient.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and c.relname <> $1
       order by 1`,
      [MIGRATIONS_TABLE],
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.filter((r) => !r.enabled || !r.forced).map((r) => r.relname)).toEqual([]);
  });

  it("every household table has policies for both mp_api and mp_worker", async () => {
    const tables = await listHouseholdTables(apiClient);
    const res = await apiClient.query<{ tablename: string; roles: string[] }>(
      `select tablename, roles::text[] as roles from pg_policies where schemaname = 'public'`,
    );
    for (const table of tables) {
      const roles = new Set(res.rows.filter((p) => p.tablename === table).flatMap((p) => p.roles));
      for (const role of APP_ROLES) expect(roles.has(role), `${table} has no policy for ${role}`).toBe(true);
    }
  });

  it("no policy applies to PUBLIC, and mp_analytics has no table privileges yet", async () => {
    const pub = await apiClient.query(`select tablename, policyname from pg_policies
      where schemaname = 'public' and 'public' = any(roles::text[])`);
    expect(pub.rows).toEqual([]);
    // Catalog functions, not information_schema (which hides grants that don't involve the current role).
    const leaks = await apiClient.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m','S')
         and (has_table_privilege('mp_analytics', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
              or exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0))`);
    expect(leaks.rows).toEqual([]);
  });

  it("app roles have no privileges on the migrations table", async () => {
    for (const role of APP_ROLES) {
      const res = await apiClient.query<{ ok: boolean }>(
        `select has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') as ok`,
        [role, MIGRATIONS_TABLE],
      );
      expect(res.rows[0]?.ok).toBe(false);
    }
  });

  it("SECURITY DEFINER functions are executable only by the roles they are meant for", async () => {
    // G1 sign-off table. Any new definer function must be added here deliberately.
    const expected: Record<string, readonly string[]> = {
      app_is_household_member: ["mp_api"],
      app_household_unclaimed_by_me: ["mp_api"],
      app_user_email: ["mp_api"],
      app_accept_invite: ["mp_api"],
      app_invite_lookup: ["mp_api"],
      app_sync_auth_user: ["mp_api", "mp_worker"],
      app_transfer_creator: ["mp_api"],
      app_purge_audit_events: ["mp_worker"],
      app_list_household_ids: ["mp_worker"],
    };
    const res = await apiClient.query<{ proname: string; roles: string[] }>(`
      select p.proname,
             array(select r from unnest(array['mp_api','mp_worker','mp_analytics']) r
                    where has_function_privilege(r, p.oid, 'EXECUTE') order by r) as roles
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
       order by 1`);
    expect(Object.fromEntries(res.rows.map((r) => [r.proname, r.roles]))).toEqual(expected);
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const res = await apiClient.query<{ proname: string; config: string[] | null }>(`
      select p.proname, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef`);
    expect(res.rows.length).toBeGreaterThan(0);
    for (const fn of res.rows) {
      expect(
        fn.config?.some((c) => c.startsWith("search_path=")),
        fn.proname,
      ).toBe(true);
    }
  });
});

describe("test connections", () => {
  it("this suite is not given any migrator URL", () => {
    expect(inject("migratorDatabaseUrl")).toBeUndefined();
    expect(inject("scratchMigratorUrls")).toBeUndefined();
  });

  it.each([
    ["databaseUrl", "mp_api"],
    ["workerDatabaseUrl", "mp_worker"],
  ] as const)("%s connects as %s, which is not a superuser and cannot bypass RLS", async (key, role) => {
    const client = new pg.Client({ connectionString: inject(key) });
    await client.connect();
    try {
      const res = await client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      );
      expect(res.rows[0]).toEqual({ current_user: role, rolsuper: false, rolbypassrls: false });
    } finally {
      await client.end();
    }
  });
});
