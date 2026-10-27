import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assertMigratorRole,
  findTransactionControl,
  loadMigrations,
  MigrationError,
  parseMigrationName,
  runMigrations,
} from "../../src/migrate";
import { MIGRATIONS_DIR } from "../setup/paths";

describe("parseMigrationName", () => {
  it("accepts YYYYMMDDHHMM_<wp>_<slug>.sql", () => {
    expect(parseMigrationName("202610271500_wp03_identity.sql")).toEqual({
      timestamp: "202610271500",
      wp: "wp03",
      slug: "identity",
    });
    expect(parseMigrationName("202612312359_wp06_items-and-occurrences.sql")?.slug).toBe(
      "items-and-occurrences",
    );
  });

  it.each([
    "0001_init.sql",
    "202610271500_identity.sql",
    "202610271500_wp3_identity.sql",
    "202613011200_wp03_bad-month.sql",
    "202610320000_wp03_bad-day.sql",
    "202610272460_wp03_bad-time.sql",
    "202610271500_wp03_Upper.sql",
    "202610271500_wp03_identity.SQL",
  ])("rejects %s", (name) => {
    expect(parseMigrationName(name)).toBeNull();
  });
});

describe("findTransactionControl (G1-3)", () => {
  it.each([
    "create table t (id int);\ncommit;",
    "COMMIT",
    "insert into t values (1); rollback;",
    "select 1;\n  Rollback ;",
    "begin; select 1; end;",
    "abort;",
    "commit and chain;",
  ])("finds transaction control in %j", (text) => {
    expect(findTransactionControl(text)).not.toBeNull();
  });

  it.each([
    "create function f() returns trigger language plpgsql as $$\nbegin\n  return new;\nend\n$$;",
    "create function g() returns void language plpgsql as $body$ begin rollback; end $body$;",
    "-- commit happens in the runner\nselect 1;",
    "/* rollback */ select 1;",
    "select 'commit; rollback;';",
    "create table commit_log (committed_at timestamptz);",
    "comment on table t is 'end';",
  ])("ignores %j", (text) => {
    expect(findTransactionControl(text)).toBeNull();
  });
});

describe("loadMigrations", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mp-migrations-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sorts by name and ignores non-sql files", async () => {
    await writeFile(join(dir, "202610271502_wp03_b.sql"), "select 2;");
    await writeFile(join(dir, "202610271501_wp03_a.sql"), "select 1;");
    await writeFile(join(dir, "README.md"), "notes");
    const files = await loadMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["202610271501_wp03_a.sql", "202610271502_wp03_b.sql"]);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails on a badly named .sql file instead of skipping it", async () => {
    await writeFile(join(dir, "add_column.sql"), "select 3;");
    await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
    await rm(join(dir, "add_column.sql"));
  });

  it("fails on a file that ends the runner's transaction itself", async () => {
    await writeFile(join(dir, "202610271503_wp03_commits.sql"), "create table x (id int);\ncommit;\n");
    await expect(loadMigrations(dir)).rejects.toThrow(/202610271503_wp03_commits\.sql.*commit/i);
    await rm(join(dir, "202610271503_wp03_commits.sql"));
  });

  it("the committed migrations are all well named", async () => {
    const committed = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    expect(committed.length).toBeGreaterThan(0);
    expect((await loadMigrations(MIGRATIONS_DIR)).length).toBe(committed.length);
  });
});

async function appliedNames(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ filename: string }>(
      "select filename from schema_migrations order by filename",
    );
    return res.rows.map((r) => r.filename);
  } finally {
    await client.end();
  }
}

async function schemaFingerprint(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ fp: string }>(`
      select string_agg(x, '|' order by x) as fp from (
        select 'col:' || table_name || '.' || column_name || ':' || data_type as x
          from information_schema.columns where table_schema = 'public'
        union all
        select 'pol:' || tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ',')
          from pg_policies where schemaname = 'public'
        union all
        select 'fn:' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
      ) s`);
    return res.rows[0]?.fp ?? "";
  } finally {
    await client.end();
  }
}

describe("runMigrations on an empty database", () => {
  const url = (): string => inject("scratchMigratorUrls").moneypilot_scratch;

  it("applies every migration in name order, then is a no-op on re-run", async () => {
    const all = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.name);

    const first = await runMigrations({ databaseUrl: url(), migrationsDir: MIGRATIONS_DIR });
    expect(first.applied).toEqual(all);
    expect(await appliedNames(url())).toEqual(all);
    const before = await schemaFingerprint(url());
    expect(before).toContain("pol:household_members");

    const second = await runMigrations({ databaseUrl: url(), migrationsDir: MIGRATIONS_DIR });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(all);
    expect(await schemaFingerprint(url())).toBe(before);
  });
});

describe("runMigrations safety checks", () => {
  const url = (): string => inject("scratchMigratorUrls").moneypilot_runner;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mp-runner-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rolls back a failing migration entirely and records nothing for it", async () => {
    await writeFile(join(dir, "202601010000_wp03_ok.sql"), "create table runner_ok (id int);");
    await writeFile(
      join(dir, "202601010001_wp03_broken.sql"),
      "create table runner_half (id int);\nselect * from table_that_does_not_exist;",
    );
    await expect(runMigrations({ databaseUrl: url(), migrationsDir: dir })).rejects.toThrow(
      /202601010001_wp03_broken/,
    );
    expect(await appliedNames(url())).toEqual(["202601010000_wp03_ok.sql"]);
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    const res = await client.query("select to_regclass('public.runner_half') as t");
    await client.end();
    expect(res.rows[0].t).toBeNull();
    await rm(join(dir, "202601010001_wp03_broken.sql"));
  });

  it("refuses to run when an applied migration was edited (checksum mismatch)", async () => {
    await writeFile(join(dir, "202601010000_wp03_ok.sql"), "create table runner_ok (id int, edited int);");
    await expect(runMigrations({ databaseUrl: url(), migrationsDir: dir })).rejects.toThrow(/checksum/i);
    await writeFile(join(dir, "202601010000_wp03_ok.sql"), "create table runner_ok (id int);");
  });

  it("refuses to run when an applied migration is missing from disk", async () => {
    await rm(join(dir, "202601010000_wp03_ok.sql"));
    await expect(runMigrations({ databaseUrl: url(), migrationsDir: dir })).rejects.toThrow(/missing/i);
    await writeFile(join(dir, "202601010000_wp03_ok.sql"), "create table runner_ok (id int);");
  });

  it("refuses a pending migration whose name sorts before the latest applied one (ADR-015 name order)", async () => {
    await writeFile(join(dir, "202601020000_wp05_later.sql"), "create table runner_later (id int);");
    expect((await runMigrations({ databaseUrl: url(), migrationsDir: dir })).applied).toEqual([
      "202601020000_wp05_later.sql",
    ]);
    await writeFile(join(dir, "202601010500_wp06_earlier.sql"), "create table runner_earlier (id int);");
    await expect(runMigrations({ databaseUrl: url(), migrationsDir: dir })).rejects.toThrow(
      /202601010500_wp06_earlier\.sql.*sorts before.*202601020000_wp05_later\.sql/,
    );
    expect(await appliedNames(url())).not.toContain("202601010500_wp06_earlier.sql");
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    const res = await client.query("select to_regclass('public.runner_earlier') as t");
    await client.end();
    expect(res.rows[0].t).toBeNull();
    await rm(join(dir, "202601010500_wp06_earlier.sql"));
  });

  it("runs concurrent invocations safely (advisory lock)", async () => {
    await writeFile(
      join(dir, "202601030000_wp03_concurrent.sql"),
      "create table runner_concurrent (id int);",
    );
    const results = await Promise.all([
      runMigrations({ databaseUrl: url(), migrationsDir: dir }),
      runMigrations({ databaseUrl: url(), migrationsDir: dir }),
    ]);
    expect(results.flatMap((r) => r.applied)).toEqual(["202601030000_wp03_concurrent.sql"]);
  });

  it("refuses to run as a superuser or a BYPASSRLS role (objects must be owned by mp_migrator)", () => {
    // Exercised through the role check helper; tests never get a superuser URL.
    const ok = { rolname: "mp_migrator", rolsuper: false, rolbypassrls: false };
    expect(() => assertMigratorRole(ok)).not.toThrow();
    expect(() => assertMigratorRole({ ...ok, rolname: "postgres", rolsuper: true })).toThrow(MigrationError);
    expect(() => assertMigratorRole({ ...ok, rolbypassrls: true })).toThrow(MigrationError);
  });
});
