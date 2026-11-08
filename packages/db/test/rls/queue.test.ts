// WP-09 (Q-105): the `mp_queue` role, the `pgboss` schema created by migration, and the narrow SECURITY DEFINER
// function through which mp_api enqueues. mp_api and mp_worker have no privilege on `pgboss`; mp_queue has none
// on `public`.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";
import { readFile } from "node:fs/promises";
import { MIGRATIONS_DIR } from "../setup/paths";
import { join } from "node:path";

let api: ApiDb;
let worker: WorkerDb;
let world: World;
let queue: pg.Pool;
let boss: PgBoss;

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asAnon = <T>(fn: (tx: Tx) => Promise<T>) => api.withHouseholdTx({ userId: null }, fn);
const enqueue = (tx: Tx, name: string, householdId: string) =>
  tx.execute<{ id: string | null }>(sql`select public.app_enqueue_job(${name}, ${householdId}::uuid) as id`);

const q = (text: string, values: unknown[] = []) => queue.query(text, values);
async function pgErrorCode(text: string): Promise<string | undefined> {
  try {
    await q(text);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
  queue = new pg.Pool({ connectionString: inject("queueDatabaseUrl"), max: 2 });
  // The production shape: pg-boss as mp_queue, schema from the migration, no migration of its own.
  boss = new PgBoss({ connectionString: inject("queueDatabaseUrl"), migrate: false, createSchema: false });
  boss.on("error", () => undefined);
  await boss.start();
  await boss.createQueue("plan.recompute", { retryLimit: 3, retryDelay: 5, retryBackoff: true });
  await boss.createQueue("reminders.plan", { policy: "short", retryLimit: 5, retryDelay: 10 });
  await boss.createQueue("imports.process");
});
afterAll(async () => {
  // `wait` is not an option of StopOptions in the pinned pg-boss 12.38.0 (it was a type error once salvaged from the
  // WP-09 branch, which had another version installed). stop() already resolves when the workers have stopped.
  await boss.stop({ graceful: false });
  await queue.end();
  await api.close();
  await worker.close();
});

describe("the mp_queue role", () => {
  it("is not a superuser, has no BYPASSRLS and cannot create roles or databases", async () => {
    const { rows } = await q(
      "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user",
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it("has no access to any table or function in public", async () => {
    expect(await pgErrorCode("select * from public.households")).toBe("42501");
    expect(await pgErrorCode("select * from public.audit_events")).toBe("42501");
    expect(await pgErrorCode("create table public.nope (id int)")).toBe("42501");
    expect(await pgErrorCode("select public.app_list_household_ids()")).toBe("42501");
    const { rows } = await q(
      `select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'mp_queue' and table_schema = 'public'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("runs pg-boss with migrate: false: the schema was created by the migration", async () => {
    const version = await q("select version from pgboss.version");
    expect(version.rows).toEqual([{ version: 46 }]);
    const id = await boss.send("imports.process", { importId: randomUUID() });
    expect(id).toBeTruthy();
    const jobs = await boss.fetch("imports.process");
    expect(jobs).toHaveLength(1);
    await boss.complete("imports.process", jobs[0]!.id);
  });
});

describe("pg-boss schema drift", () => {
  it("the migration carries the construction plan of the installed pg-boss", async () => {
    const migration = await readFile(join(MIGRATIONS_DIR, "202611091400_wp09_pgboss-queue-role.sql"), "utf8");
    const plan = getConstructionPlans("pgboss");
    const body = plan
      .split("\n")
      .slice(4) // BEGIN, two SET LOCAL, advisory lock
      .join("\n")
      .replace(/\n\s*COMMIT;\s*$/, "")
      // The one deliberate difference: the schema creation is guarded (see the migration's comment).
      .replace(
        "CREATE SCHEMA IF NOT EXISTS pgboss;",
        "DO $guard$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN CREATE SCHEMA pgboss; END IF; END $guard$;",
      );
    const version = /INSERT INTO pgboss\.version\(version\) VALUES \('(\d+)'\)/.exec(body)?.[1];
    expect(version, "pg-boss schema version changed: add a migration").toBe("46");
    expect(migration, "pg-boss construction plan changed: add a migration, never edit this one").toContain(
      body.trim(),
    );
  });
});

describe("pgboss is closed to the application roles", () => {
  it("mp_api and mp_worker cannot read or write pgboss tables, nor call its functions", async () => {
    await expectDenied(() => asA((tx) => tx.execute(sql`select * from pgboss.job`)));
    await expectDenied(() => asA((tx) => tx.execute(sql`select * from pgboss.queue`)));
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into pgboss.job (name, data) values ('plan.recompute', '{}'::jsonb)`),
      ),
    );
    await expectDenied(() => asA((tx) => tx.execute(sql`select pgboss.job_now()`)));
    await expectDenied(() => worker.withJobTx(world.a.id, (tx) => tx.execute(sql`select * from pgboss.job`)));
  });

  it("PUBLIC has no usage on the schema", async () => {
    const { rows } = await q("select has_schema_privilege('public', 'pgboss', 'USAGE') as usage");
    expect(rows[0].usage).toBe(false);
  });
});

describe("app_enqueue_job", () => {
  it("is executable by mp_api only", async () => {
    await expectDenied(() => worker.withJobTx(world.a.id, (tx) => enqueue(tx, "plan.recompute", world.a.id)));
    expect(await pgErrorCode(`select public.app_enqueue_job('plan.recompute', '${world.a.id}')`)).toBe(
      "42501",
    );
  });

  it("enqueues a job for a household the caller belongs to, with the queue's own settings", async () => {
    const rows = await asA((tx) => enqueue(tx, "reminders.plan", world.a.id));
    const id = rows.rows[0]?.id;
    expect(id).toBeTruthy();
    const job = await q("select * from pgboss.job where id = $1", [id]);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]).toMatchObject({
      name: "reminders.plan",
      data: { householdId: world.a.id },
      state: "created",
      singleton_key: `reminders.plan:${world.a.id}`,
      policy: "short",
      retry_limit: 5,
      retry_delay: 10,
    });
  });

  it("does not enqueue a second equal job while one waits (singleton)", async () => {
    const first = await asA((tx) => enqueue(tx, "reminders.plan", world.a.id));
    expect(first.rows[0]?.id).toBeNull(); // the previous test's job is still queued
  });

  it("debounces plan.recompute into one job per household per 2-second slot, started after the slot", async () => {
    const ids: (string | null)[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await asA((tx) => enqueue(tx, "plan.recompute", world.a.id))).rows[0]?.id ?? null);
    const created = ids.filter((id) => id !== null);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.length).toBeLessThanOrEqual(2); // a slot boundary may fall between the calls
    const job = await q(
      `select data, singleton_key, start_after > now() as delayed, retry_limit
         from pgboss.job where id = $1`,
      [created[0]],
    );
    expect(job.rows[0]).toMatchObject({
      data: { householdId: world.a.id },
      singleton_key: `plan.recompute:${world.a.id}`,
      delayed: true,
      retry_limit: 3,
    });
  });

  it("refuses a household the caller is not a member of (cross-household)", async () => {
    await expectDenied(() => asA((tx) => enqueue(tx, "plan.recompute", world.b.id)));
    await expectDenied(() => asA((tx) => enqueue(tx, "reminders.plan", randomUUID())));
    const none = await q("select count(*)::int as n from pgboss.job where data->>'householdId' = $1", [
      world.b.id,
    ]);
    expect(none.rows[0].n).toBe(0);
  });

  it("refuses a caller with no user, and a null household", async () => {
    await expectDenied(() => asAnon((tx) => enqueue(tx, "plan.recompute", world.a.id)));
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`select public.app_enqueue_job('plan.recompute', null::uuid)`)),
    );
  });

  it("refuses every queue outside the allowlist, even one that exists", async () => {
    for (const name of ["imports.process", "billing.sync", "notifications.dispatch", "pgboss.send", ""]) {
      await expectDenied(() => asA((tx) => enqueue(tx, name, world.a.id)));
    }
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`select public.app_enqueue_job(null, ${world.a.id}::uuid)`)),
    );
  });

  it("fails with 55000 while the worker has not created the queue", async () => {
    await q("delete from pgboss.job where name = 'reminders.plan'");
    await boss.deleteQueue("reminders.plan");
    await expectRejected(() => asA((tx) => enqueue(tx, "reminders.plan", world.a.id)), "55000");
  });

  it("takes no job data, key or timing from the caller (fixed two-argument signature)", async () => {
    const { rows } = await q(
      `select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
         from pg_proc p where p.proname = 'app_enqueue_job'`,
    );
    expect(rows).toEqual([{ args: "p_queue text, p_household_id uuid", prosecdef: true }]);
  });
});
