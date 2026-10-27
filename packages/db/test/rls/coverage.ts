import type pg from "pg";

/**
 * Every table in `public` with a `household_id` column. Uses pg_catalog rather than
 * information_schema: information_schema only lists columns the current role has privileges on, so a
 * new table nobody granted yet would be invisible and silently skip the coverage check.
 */
export async function listHouseholdTables(client: pg.ClientBase): Promise<string[]> {
  const res = await client.query<{ table_name: string }>(`
    select c.relname as table_name
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and a.attname = 'household_id' and a.attnum > 0 and not a.attisdropped
     order by 1`);
  return res.rows.map((r) => r.table_name);
}

export interface CoverageReport {
  /** Tables with household_id that have no cross-tenant case. */
  missing: string[];
  /** Cases for tables that no longer exist. */
  stale: string[];
}

export function checkCoverage(dbTables: readonly string[], coveredTables: readonly string[]): CoverageReport {
  const covered = new Set(coveredTables);
  const present = new Set(dbTables);
  return {
    missing: dbTables.filter((t) => !covered.has(t)),
    stale: coveredTables.filter((t) => !present.has(t)),
  };
}
