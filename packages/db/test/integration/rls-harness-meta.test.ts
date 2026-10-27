// META test for the RLS harness (WP-03 acceptance): a new table with household_id and no cross-tenant
// case must make the coverage check fail. Creating a table needs the schema owner, so this runs as
// mp_migrator inside a transaction it rolls back. It asserts nothing about row access, which is why it
// lives here and not in `pnpm test:rls` (that suite connects only as mp_api / mp_worker).
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { householdTableCases } from "../rls/cases";
import { checkCoverage, listHouseholdTables } from "../rls/coverage";

describe("RLS harness META", () => {
  it("a new table with household_id and no case makes the coverage check fail", async () => {
    const covered = householdTableCases.map((c) => c.table);
    const migrator = new pg.Client({ connectionString: inject("migratorDatabaseUrl") });
    await migrator.connect();
    try {
      await migrator.query("begin");
      // Even an ungranted, RLS-less table must be found (no information_schema blind spot).
      await migrator.query("create table rls_meta_probe (id uuid primary key, household_id uuid not null)");
      const report = checkCoverage(await listHouseholdTables(migrator), covered);
      expect(report.missing).toEqual(["rls_meta_probe"]);
    } finally {
      await migrator.query("rollback");
      await migrator.end();
    }
    const api = new pg.Client({ connectionString: inject("databaseUrl") });
    await api.connect();
    try {
      expect(await listHouseholdTables(api)).not.toContain("rls_meta_probe");
    } finally {
      await api.end();
    }
  });
});
