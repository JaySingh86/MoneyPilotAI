// WP-06 table rules beyond plain isolation (the generic cross-household cases are in cases.ts):
// the narrowed occurrence delete policy, tenant-safe foreign keys, role grants and version triggers.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const FOREIGN_KEY_VIOLATION = "23503";

let api: ApiDb;
let worker: WorkerDb;
let world: World;
let rowsA: World["a"]["items"];
let rowsB: World["b"]["items"];

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
  rowsA = world.a.items;
  rowsB = world.b.items;
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("tenant-safe foreign keys", () => {
  it("a member cannot attach an occurrence or amount history to another household's item", async () => {
    // Household A's creator names household B's item in A's own household: RLS passes, the composite FK fails.
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
            values (${world.a.id}, ${rowsB.itemId}, '2026-12-01', '2026-12-01')`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
            values (${world.a.id}, ${rowsB.itemId}, '2026-12-01', 1, 'manual')`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("a planned expense cannot be paid from another household's goal", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into planned_expenses (household_id, name, amount_cents, due_on, owner_type, goal_id, created_by)
            values (${world.a.id}, 'Trip', 100, '2026-12-01', 'both', ${rowsB.goalId}, ${world.a.creator.id})`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("a household cannot name another household's item as its primary income", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(
            sql`update households set primary_income_item_id = ${rowsB.itemId} where id = ${world.a.id}`,
          ),
        ),
      FOREIGN_KEY_VIOLATION,
    );
    // Its own item is fine.
    await asA((tx) =>
      tx.execute(
        sql`update households set primary_income_item_id = ${rowsA.itemId} where id = ${world.a.id}`,
      ),
    );
  });
});

describe("occurrences are only deleted while scheduled", () => {
  let nextDay = 1;
  async function paidOccurrence(): Promise<string> {
    const day = `2026-12-${String(nextDay++).padStart(2, "0")}`;
    return asA(async (tx) => {
      const res = await tx.execute<{
        id: string;
      }>(sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
        values (${world.a.id}, ${rowsA.itemId}, ${day}::date, ${day}::date) returning id`);
      const id = res.rows[0]?.id ?? "";
      await tx.execute(sql`update occurrences set status = 'paid', paid_on = ${day}::date, marked_by = ${world.a.creator.id}
        where id = ${id}`);
      return id;
    });
  }

  it("mp_api deletes 0 paid rows and the scheduled row", async () => {
    const id = await paidOccurrence();
    const deleted = await asA((tx) => tx.execute(sql`delete from occurrences where id = ${id}`));
    expect(deleted.rowCount).toBe(0);
    const scheduled = await asA((tx) =>
      tx.execute(sql`delete from occurrences where id = ${rowsA.occurrenceId}`),
    );
    expect(scheduled.rowCount).toBe(1);
  });

  it("mp_worker follows the same rule", async () => {
    const id = await paidOccurrence();
    const deleted = await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`delete from occurrences where id = ${id}`),
    );
    expect(deleted.rowCount).toBe(0);
  });

  it("a paid or received occurrence needs its paid date", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          (async () => {
            const res = await tx.execute<{
              id: string;
            }>(sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
              values (${world.a.id}, ${rowsA.itemId}, '2027-01-01', '2027-01-01') returning id`);
            await tx.execute(sql`update occurrences set status = 'paid' where id = ${res.rows[0]?.id ?? ""}`);
          })(),
        ),
      "23514",
    );
  });
});

describe("roles and columns", () => {
  it("occurrence identity is immutable: scheduled_on, item_id and household_id cannot be updated", async () => {
    for (const column of ["scheduled_on", "item_id", "household_id"] as const) {
      const value = column === "scheduled_on" ? sql`'2027-02-02'::date` : sql`gen_random_uuid()`;
      await expectDenied(() =>
        asA((tx) =>
          tx.execute(
            sql`update occurrences set ${sql.identifier(column)} = ${value} where id = ${rowsA.occurrenceId}`,
          ),
        ),
      );
    }
  });

  it("version is not client-writable; every update bumps it by one", async () => {
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`update recurring_items set version = 99 where id = ${rowsA.itemId}`)),
    );
    const v = async () =>
      (
        await asA((tx) =>
          tx.execute<{ version: number }>(
            sql`select version from recurring_items where id = ${rowsA.itemId}`,
          ),
        )
      ).rows[0]?.version;
    const before = await v();
    await asA((tx) => tx.execute(sql`update recurring_items set notes = 'a' where id = ${rowsA.itemId}`));
    await asA((tx) => tx.execute(sql`update recurring_items set notes = 'b' where id = ${rowsA.itemId}`));
    expect(await v()).toBe((before ?? 0) + 2);
  });

  it("recurring items cannot be hard-deleted by the app (soft delete only)", async () => {
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`delete from recurring_items where id = ${rowsA.itemId}`)),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) =>
        tx.execute(sql`delete from recurring_items where id = ${rowsA.itemId}`),
      ),
    );
  });

  it("balances are append-only for both app roles", async () => {
    await expectDenied(() => asA((tx) => tx.execute(sql`update balances set amount_cents = 1`)));
    await expectDenied(() => asA((tx) => tx.execute(sql`delete from balances`)));
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) => tx.execute(sql`update balances set amount_cents = 1`)),
    );
    await expectDenied(() => worker.withJobTx(world.a.id, (tx) => tx.execute(sql`delete from balances`)));
  });

  it("the worker materializes occurrences for its own household and sees the items", async () => {
    const n = await worker.withJobTx(world.a.id, async (tx) => {
      await tx.execute(sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
        values (${world.a.id}, ${rowsA.itemId}, '2027-03-01', '2027-03-01') on conflict (item_id, scheduled_on) do nothing`);
      return count(tx, sql`select 1 from occurrences where item_id = ${rowsA.itemId}`);
    });
    expect(n).toBeGreaterThan(0);
  });

  it("at most one live emergency fund per household", async () => {
    await expectRejected(
      () =>
        worker.withJobTx(world.a.id, (tx) =>
          tx.execute(sql`insert into goals (household_id, name, type, target_cents, is_emergency_fund)
            values (${world.a.id}, 'Second fund', 'savings', 100, true)`),
        ),
      "23505",
    );
  });
});

describe("G1 M-2: the API only writes hand-entered rows, as the caller", () => {
  const item = (source: string, createdBy: string | null) =>
    sql`insert into recurring_items
        (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, owner_type, source, created_by)
      values (${world.a.id}, 'outflow', 'bill', 'other', 'Probe', 'fixed', 100, 'FREQ=MONTHLY;BYMONTHDAY=1',
        '2026-01-01', 'both', ${source}, ${createdBy})`;

  it("mp_api cannot insert an item with a csv, email or bank source, or attributed to someone else", async () => {
    for (const source of ["csv", "email", "bank"]) {
      await expectDenied(() => asA((tx) => tx.execute(item(source, world.a.creator.id))));
    }
    await expectDenied(() => asA((tx) => tx.execute(item("manual", world.a.partner.id))));
    await expectDenied(() => asA((tx) => tx.execute(item("manual", null))));
    await asA((tx) => tx.execute(item("manual", world.a.creator.id)));
  });

  it("mp_worker can write pipeline sources for its own household only", async () => {
    await worker.withJobTx(world.a.id, (tx) => tx.execute(item("csv", world.a.creator.id)));
    await expectDenied(() =>
      worker.withJobTx(world.b.id, (tx) => tx.execute(item("csv", world.a.creator.id))),
    );
  });

  it("mp_api cannot insert non-manual amount history or balances, nor attribute them to someone else", async () => {
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
          values (${world.a.id}, ${rowsA.itemId}, '2026-08-01', 1, 'csv')`),
      ),
    );
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into balances (household_id, amount_cents, as_of, source, recorded_by)
          values (${world.a.id}, 1, '2026-10-27', 'csv', ${world.a.creator.id})`),
      ),
    );
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into balances (household_id, amount_cents, as_of, source, recorded_by)
          values (${world.a.id}, 1, '2026-10-27', 'manual', ${world.a.partner.id})`),
      ),
    );
    await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`insert into balances (household_id, amount_cents, as_of, source)
        values (${world.a.id}, 2, '2026-10-27', 'csv')`),
    );
  });

  it("a planned expense is attributed to the caller", async () => {
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into planned_expenses (household_id, name, amount_cents, due_on, owner_type, created_by)
          values (${world.a.id}, 'Spoof', 100, '2026-12-01', 'both', ${world.a.partner.id})`),
      ),
    );
  });
});

describe("G1 L-1: an item or planned expense is owned by a member of its household", () => {
  it("rejects an owner from another household, on insert and on update", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into recurring_items
              (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, owner_type,
               owner_user_id, source, created_by)
            values (${world.a.id}, 'outflow', 'bill', 'other', 'Foreign owner', 'fixed', 100, 'FREQ=MONTHLY;BYMONTHDAY=1',
              '2026-01-01', 'member', ${world.b.creator.id}, 'manual', ${world.a.creator.id})`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(
            sql`update recurring_items set owner_type = 'member', owner_user_id = ${world.b.creator.id} where id = ${rowsA.itemId}`,
          ),
        ),
      FOREIGN_KEY_VIOLATION,
    );
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into planned_expenses (household_id, name, amount_cents, due_on, owner_type, owner_user_id, created_by)
            values (${world.a.id}, 'Foreign owner', 100, '2026-12-01', 'member', ${world.b.creator.id}, ${world.a.creator.id})`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe("Q-050: goals are written through the API only after WP-13 (proposal gate in the service)", () => {
  it("mp_api reads goals, inserts its own household's goals as itself, and never hard deletes", async () => {
    expect(
      await asA((tx) => count(tx, sql`select 1 from goals where household_id = ${world.a.id}`)),
    ).toBeGreaterThan(0);
    // WP-13 grants (see test/rls/wp13.test.ts for the full set of rules).
    await asA((tx) =>
      tx.execute(sql`insert into goals (household_id, name, type, target_cents, created_by)
        values (${world.a.id}, 'Mine', 'savings', 100, ${world.a.creator.id})`),
    );
    await expectDenied(() => asA((tx) => tx.execute(sql`delete from goals where id = ${rowsA.goalId}`)));
  });
});

describe("Q-051: app_list_household_ids()", () => {
  it("returns ids only, to mp_worker only", async () => {
    const ids = await worker.withJobTx(world.a.id, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`select app_list_household_ids() as id`);
      return res.rows.map((r) => r.id);
    });
    expect(ids).toEqual(expect.arrayContaining([world.a.id, world.b.id]));
    await expectDenied(() => asA((tx) => tx.execute(sql`select app_list_household_ids()`)));
  });

  it("is a SECURITY DEFINER function with a pinned search_path that no one but mp_worker can execute", async () => {
    const res = await asA((tx) => tx.execute(sql`select 1`)); // keep the pool warm; catalog check below uses pg_proc
    expect(res.rows).toHaveLength(1);
    const meta = await asA((tx) =>
      tx.execute<{ secdef: boolean; config: string[] | null; public_exec: boolean }>(sql`
        select p.prosecdef as secdef, p.proconfig as config,
               has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
          from pg_proc p where p.proname = 'app_list_household_ids'`),
    );
    expect(meta.rows[0]).toMatchObject({ secdef: true, public_exec: false });
    expect(meta.rows[0]?.config?.some((c) => c.startsWith("search_path=pg_catalog"))).toBe(true);
  });
});
