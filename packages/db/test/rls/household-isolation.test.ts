// User A gets 0 rows from household B on every table with household_id: select, insert, update and
// delete attempts, as mp_api (member, member with a spoofed app.household_id, stranger) and as
// mp_worker scoped to another household (WP-03 acceptance, ADR-003).
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { householdTableCases } from "./cases";
import { count, expectDenied, expectNoRowsAffected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

interface Actor {
  name: string;
  /** The attacker's own household, if any (positive control: it must see its own rows). */
  ownHouseholdId: (w: World) => string | null;
  actorUserId: (w: World) => string | null;
  run: <T>(w: World, fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const actors: Actor[] = [
  {
    name: "mp_api · member of A",
    ownHouseholdId: (w) => w.a.id,
    actorUserId: (w) => w.a.creator.id,
    run: (w, fn) => api.withHouseholdTx({ userId: w.a.creator.id, householdId: w.a.id }, fn),
  },
  {
    name: "mp_api · member of A with app.household_id spoofed to B",
    ownHouseholdId: (w) => w.a.id,
    actorUserId: (w) => w.a.partner.id,
    run: (w, fn) => api.withHouseholdTx({ userId: w.a.partner.id, householdId: w.b.id }, fn),
  },
  {
    name: "mp_api · signed-in stranger",
    ownHouseholdId: () => null,
    actorUserId: (w) => w.stranger.id,
    run: (w, fn) => api.withHouseholdTx({ userId: w.stranger.id, authSubject: w.stranger.authSubject }, fn),
  },
  {
    name: "mp_worker · job for A",
    ownHouseholdId: (w) => w.a.id,
    actorUserId: () => null,
    run: (w, fn) => worker.withJobTx(w.a.id, fn),
  },
];

const victimCounts = new Map<string, number>();
const victimView = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  api.withHouseholdTx({ userId: world.b.creator.id, householdId: world.b.id }, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
  for (const c of householdTableCases) {
    const n = await victimView((tx) =>
      count(tx, sql`select 1 from ${sql.identifier(c.table)} where household_id = ${world.b.id}`),
    );
    expect(n, `victim household must have ${c.table} rows for the test to mean anything`).toBeGreaterThan(0);
    victimCounts.set(c.table, n);
  }
});

afterAll(async () => {
  await api.close();
  await worker.close();
});

describe.each(householdTableCases)("$table", (c) => {
  const table = sql.identifier(c.table);

  describe.each(actors)("$name", (actor) => {
    it("sees its own household's rows (positive control)", async () => {
      const own = actor.ownHouseholdId(world);
      if (!own) return;
      const n = await actor.run(world, (tx) =>
        count(tx, sql`select 1 from ${table} where household_id = ${own}`),
      );
      expect(n).toBeGreaterThan(0);
    });

    it("selects 0 rows of household B, and 0 rows of any household but its own", async () => {
      const own = actor.ownHouseholdId(world);
      await actor.run(world, async (tx) => {
        expect(await count(tx, sql`select 1 from ${table} where household_id = ${world.b.id}`)).toBe(0);
        expect(await count(tx, sql`select 1 from ${table} where household_id is distinct from ${own}`)).toBe(
          0,
        );
      });
    });

    it("cannot insert a row into household B", async () => {
      await expectDenied(() =>
        actor.run(world, (tx) =>
          tx.execute(
            c.insert({
              householdId: world.b.id,
              actorUserId: actor.actorUserId(world),
              someUserId: world.a.creator.id,
            }),
          ),
        ),
      );
    });

    it("updates 0 rows of household B", async () => {
      await expectNoRowsAffected(() =>
        actor.run(world, (tx) =>
          tx.execute(
            c.update({
              householdId: world.b.id,
              actorUserId: actor.actorUserId(world),
              someUserId: world.a.creator.id,
            }),
          ),
        ),
      );
    });

    it("deletes 0 rows of household B", async () => {
      await expectNoRowsAffected(() =>
        actor.run(world, (tx) => tx.execute(sql`delete from ${table} where household_id = ${world.b.id}`)),
      );
    });
  });

  it("household B still has exactly its rows, unchanged", async () => {
    const n = await victimView((tx) =>
      count(tx, sql`select 1 from ${table} where household_id = ${world.b.id}`),
    );
    expect(n).toBe(victimCounts.get(c.table));
    if (c.table === "household_members") {
      const active = await victimView((tx) =>
        count(
          tx,
          sql`select 1 from household_members where household_id = ${world.b.id} and left_at is null`,
        ),
      );
      expect(active).toBe(2);
    }
    if (c.table === "audit_events") {
      const tampered = await victimView((tx) =>
        count(
          tx,
          sql`select 1 from audit_events where household_id = ${world.b.id} and action in ('tampered', 'rls.probe')`,
        ),
      );
      expect(tampered).toBe(0);
    }
  });
});
