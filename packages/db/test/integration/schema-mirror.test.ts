import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MIGRATIONS_TABLE } from "../../src/migrate";
import * as schema from "../../src/schema";

// The SQL migrations are the source of truth (ADR-015). The Drizzle mirror must match them column by
// column: name, SQL type and nullability. Reads catalog metadata only.
const tables = Object.values(schema) as PgTable[];

interface DbColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  not_null: boolean;
}

describe("Drizzle schema mirrors the migrations", () => {
  let client: pg.Client;
  let dbColumns: DbColumn[];
  beforeAll(async () => {
    client = new pg.Client({ connectionString: inject("databaseUrl") });
    await client.connect();
    // pg_catalog (not information_schema) so columns are listed whatever the role's grants are.
    dbColumns = (
      await client.query<DbColumn>(`
        select c.relname as table_name, a.attname as column_name,
               format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull as not_null
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped`)
    ).rows;
  });
  afterAll(async () => {
    await client.end();
  });

  it("mirrors exactly the set of tables the migrations create (both directions)", () => {
    const inDb = [...new Set(dbColumns.map((c) => c.table_name))]
      .filter((t) => t !== MIGRATIONS_TABLE)
      .sort();
    const mirrored = tables.map((t) => getTableConfig(t).name).sort();
    expect(mirrored).toEqual(inDb);
  });

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))("%s", (name, table) => {
    const config = getTableConfig(table);
    const pkColumns = new Set(config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)));
    const mirror = config.columns
      .map((c) => ({
        column_name: c.name,
        data_type: normalize(c.getSQLType()),
        not_null: c.notNull || c.primary || pkColumns.has(c.name),
      }))
      .sort((a, b) => a.column_name.localeCompare(b.column_name));
    const actual = dbColumns
      .filter((c) => c.table_name === name)
      .map(({ column_name, data_type, not_null }) => ({
        column_name,
        data_type: normalize(data_type),
        not_null,
      }))
      .sort((a, b) => a.column_name.localeCompare(b.column_name));
    expect(actual.length).toBeGreaterThan(0);
    expect(mirror).toEqual(actual);
  });
});

function normalize(type: string): string {
  return type
    .replace(/^timestamp with time zone$/, "timestamptz")
    .replace(/^timestamp\s*\(\s*\w*\s*\) with time zone$/, "timestamptz")
    .replace(/^character\((\d+)\)$/, "char($1)")
    .replace(/^bigserial$/, "bigint")
    .replace(/^integer$/, "integer");
}
