// WP-12 table rules beyond plain isolation (cases.ts covers the cross-household cases): snapshots are
// immutable for both app roles, deduplicated by (household, inputs_hash, engine_version), and the hash
// must be a sha256 digest.
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

const insert = (tx: Tx, householdId: string, hash: Buffer, version = "1.0.0") =>
  tx.execute(sql`insert into calc_snapshots (household_id, engine_version, as_of, inputs_hash, result)
    values (${householdId}, ${version}, '2026-10-27', ${hash}, '{}'::jsonb)`);

describe("calc_snapshots", () => {
  it("is immutable: neither role can update or delete", async () => {
    await expectDenied(() => asA((tx) => tx.execute(sql`update calc_snapshots set result = '{}'::jsonb`)));
    await expectDenied(() => asA((tx) => tx.execute(sql`delete from calc_snapshots`)));
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) => tx.execute(sql`update calc_snapshots set as_of = '2026-01-01'`)),
    );
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) => tx.execute(sql`delete from calc_snapshots`)),
    );
  });

  it("deduplicates by household, input hash and engine version", async () => {
    const hash = randomBytes(32);
    await asA((tx) => insert(tx, world.a.id, hash));
    await expectRejected(() => asA((tx) => insert(tx, world.a.id, hash)), UNIQUE_VIOLATION);
    // a new engine version for the same input is a new snapshot
    await asA((tx) => insert(tx, world.a.id, hash, "1.1.0"));
    // `on conflict do nothing` works with only INSERT privileges and returns no row
    const res = await asA((tx) =>
      tx.execute(sql`insert into calc_snapshots (household_id, engine_version, as_of, inputs_hash, result)
        values (${world.a.id}, '1.0.0', '2026-10-27', ${hash}, '{}'::jsonb) on conflict do nothing returning id`),
    );
    expect(res.rows).toHaveLength(0);
  });

  it("the same input hash may exist in two households", async () => {
    const hash = randomBytes(32);
    await asA((tx) => insert(tx, world.a.id, hash));
    await api.withHouseholdTx({ userId: world.b.creator.id, householdId: world.b.id }, (tx) =>
      insert(tx, world.b.id, hash),
    );
  });

  it("requires a 32-byte hash", async () => {
    await expectRejected(() => asA((tx) => insert(tx, world.a.id, randomBytes(8))), CHECK_VIOLATION);
  });

  it("a worker job writes and reads only its own household's snapshots", async () => {
    const hash = randomBytes(32);
    const n = await worker.withJobTx(world.a.id, async (tx) => {
      await insert(tx, world.a.id, hash);
      return count(tx, sql`select 1 from calc_snapshots where inputs_hash = ${hash}`);
    });
    expect(n).toBe(1);
    await expectDenied(() => worker.withJobTx(world.a.id, (tx) => insert(tx, world.b.id, randomBytes(32))));
  });
});
