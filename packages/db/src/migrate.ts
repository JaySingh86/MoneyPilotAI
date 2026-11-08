// Forward-only SQL migration runner (ADR-015).
// Files are `YYYYMMDDHHMM_<wp>_<slug>.sql` in packages/db/migrations, applied in name order, each in
// its own transaction. Applied files are recorded with a sha256 checksum; editing a file after it was
// applied, or deleting it, stops the runner before it changes anything.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { pgConfig } from "./connection";

export const MIGRATIONS_TABLE = "schema_migrations";
/** Arbitrary constant key for pg_advisory_lock so concurrent runners serialize. */
const ADVISORY_LOCK_KEY = 4_206_031;

const NAME_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})_(wp\d{2})_([a-z0-9][a-z0-9_-]*)\.sql$/;

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export interface MigrationName {
  timestamp: string;
  wp: string;
  slug: string;
}

export interface MigrationFile extends MigrationName {
  name: string;
  sql: string;
  checksum: string;
}

export interface RunMigrationsOptions {
  /** Must be the schema owner (mp_migrator), never a superuser. */
  databaseUrl: string;
  migrationsDir: string;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

export function parseMigrationName(name: string): MigrationName | null {
  const m = NAME_PATTERN.exec(name);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, min, wp, slug] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31 || Number(hh) > 23 || Number(min) > 59) return null;
  return { timestamp: `${yyyy}${mm}${dd}${hh}${min}`, wp, slug };
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Reads every `.sql` file in the directory. A badly named `.sql` file is an error, not skipped. */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const parsed = parseMigrationName(name);
    if (!parsed) {
      throw new MigrationError(
        `Migration file name ${name} must match YYYYMMDDHHMM_<wp>_<slug>.sql (ADR-015).`,
      );
    }
    const sql = await readFile(join(dir, name), "utf8");
    const control = findTransactionControl(sql);
    if (control) {
      throw new MigrationError(
        `Migration ${name} contains a top-level ${control.toUpperCase()}. The runner owns the transaction; remove it.`,
      );
    }
    files.push({ name, ...parsed, sql, checksum: checksumOf(sql) });
  }
  return files;
}

/**
 * Top-level transaction control in a migration would end the runner's transaction early, so a failure
 * after it could no longer be rolled back with the file. Returns the first offending keyword, or null.
 * Comments, quoted strings/identifiers and dollar-quoted bodies (plpgsql BEGIN/END) are ignored.
 */
export function findTransactionControl(sql: string): string | null {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      current += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += " ";
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === ch && sql.charAt(j + 1) === ch) j += 2;
        else if (sql.charAt(j) === ch) break;
        else j += 1;
      }
      i = j + 1;
      current += " x ";
    } else if (ch === "$" && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0] ?? "$$";
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      current += " x ";
    } else if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  statements.push(current);
  for (const statement of statements) {
    const m = TRANSACTION_CONTROL.exec(statement);
    if (m?.[1]) return m[1].toLowerCase().replace(/\s+/g, " ");
  }
  return null;
}

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const TRANSACTION_CONTROL =
  /^\s*(commit|rollback|end|abort|begin|start\s+transaction|prepare\s+transaction)\b/i;

/** The migrator must own what it creates and stay under RLS: never a superuser or BYPASSRLS role. */
export function assertMigratorRole(role: {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}): void {
  if (role.rolsuper || role.rolbypassrls) {
    throw new MigrationError(
      `Refusing to migrate as ${role.rolname} (superuser or BYPASSRLS). Use MIGRATOR_DATABASE_URL (mp_migrator) so it owns every object.`,
    );
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const files = await loadMigrations(options.migrationsDir);
  const client = new pg.Client(pgConfig(options.databaseUrl));
  await client.connect();
  try {
    const role = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    const current = role.rows[0];
    if (!current) throw new MigrationError("Could not read the current role.");
    assertMigratorRole(current);

    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`create table if not exists ${MIGRATIONS_TABLE} (
        filename   text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
      const appliedRows = await client.query<{ filename: string; checksum: string }>(
        `select filename, checksum from ${MIGRATIONS_TABLE} order by filename`,
      );
      const applied = new Map(appliedRows.rows.map((r) => [r.filename, r.checksum]));
      const onDisk = new Map(files.map((f) => [f.name, f]));

      for (const [filename, checksum] of applied) {
        const file = onDisk.get(filename);
        if (!file) {
          throw new MigrationError(`Applied migration ${filename} is missing from ${options.migrationsDir}.`);
        }
        if (file.checksum !== checksum) {
          throw new MigrationError(
            `Checksum mismatch for applied migration ${filename}. Merged migrations are never edited; add a new one.`,
          );
        }
      }

      // ADR-015: applied in name order. A pending file that sorts before the latest applied one (e.g. a
      // branch merged late with an older timestamp) is refused; rename it to a later timestamp.
      const latestApplied = [...applied.keys()].sort().at(-1);
      const outOfOrder = latestApplied
        ? files.find((f) => !applied.has(f.name) && f.name < latestApplied)
        : undefined;
      if (outOfOrder && latestApplied) {
        throw new MigrationError(
          `Pending migration ${outOfOrder.name} sorts before already applied ${latestApplied}. Rename it with a later timestamp.`,
        );
      }

      const result: RunMigrationsResult = { applied: [], alreadyApplied: [] };
      for (const file of files) {
        if (applied.has(file.name)) {
          result.alreadyApplied.push(file.name);
          continue;
        }
        try {
          await client.query("begin");
          await client.query(file.sql);
          await client.query(`insert into ${MIGRATIONS_TABLE} (filename, checksum) values ($1, $2)`, [
            file.name,
            file.checksum,
          ]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          const detail = error instanceof Error ? error.message : String(error);
          throw new MigrationError(`Migration ${file.name} failed and was rolled back: ${detail}`, {
            cause: error,
          });
        }
        result.applied.push(file.name);
      }
      return result;
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
