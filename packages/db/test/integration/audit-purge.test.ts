// Q-012 / G1-5: app_purge_audit_events() (BACKEND_PLAN §7.11). Audit events are kept 2 years; events
// of a deleted household are reduced to a tombstone (household_id, action, time) kept 1 year.
// Backdated rows can only be written by the table owner, so this test seeds them as mp_migrator;
// the purge itself runs as mp_worker, the only role allowed to execute it.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "../../src/tx";
import { expectDenied } from "../rls/helpers";
import { buildHousehold, type TestHousehold } from "../rls/world";

interface Row {
  id: string;
  household_id: string | null;
  actor_user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  tombstoned: boolean;
}

let api: ApiDb;
let worker: WorkerDb;
let migrator: pg.Client;
let live: TestHousehold;
const deletedHousehold = randomUUID();
const ids: Record<string, string> = {};

async function insert(label: string, values: string): Promise<void> {
  const res = await migrator.query<{ id: string }>(
    `insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id,
       metadata, ip, user_agent, created_at, tombstoned_at)
     values ${values} returning id`,
  );
  ids[label] = String(res.rows[0]?.id);
}

async function read(label: string): Promise<Row | undefined> {
  const res = await migrator.query<Row>(
    `select id, household_id, actor_user_id, action, entity_type, entity_id, metadata, host(ip) as ip,
            user_agent, tombstoned_at is not null as tombstoned
       from audit_events where id = $1`,
    [ids[label]],
  );
  return res.rows[0];
}

beforeAll(async () => {
  api = createApiDb({ connectionString: inject("databaseUrl") });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl") });
  migrator = new pg.Client({ connectionString: inject("migratorDatabaseUrl") });
  await migrator.connect();
  live = await buildHousehold(api, "purge");
  const actor = live.creator.id;
  const full = (hh: string, created: string, tomb = "null") =>
    `('${hh}', '${actor}', 'user', 'item.updated', 'item', '${randomUUID()}', '{"field":"name"}', '10.0.0.1',
      'agent', ${created}, ${tomb})`;
  await insert("liveOld", full(live.id, "now() - interval '2 years 1 day'"));
  await insert("liveRecent", full(live.id, "now() - interval '1 year'"));
  await insert("deletedRecent", full(deletedHousehold, "now() - interval '3 days'"));
  await insert("deletedOld", full(deletedHousehold, "now() - interval '2 years 1 day'"));
  await insert(
    "oldTombstone",
    `('${randomUUID()}', null, 'user', 'household.deleted', null, null, '{}', null, null,
      now() - interval '400 days', now() - interval '1 year 1 day')`,
  );
  await insert(
    "freshTombstone",
    `('${randomUUID()}', null, 'user', 'household.deleted', null, null, '{}', null, null,
      now() - interval '30 days', now() - interval '20 days')`,
  );
  await insert(
    "userLevel",
    `(null, '${actor}', 'user', 'account.mfa_enabled', null, null, '{}', null, null,
      now() - interval '10 days', null)`,
  );
});

afterAll(async () => {
  await migrator.end();
  await api.close();
  await worker.close();
});

const purge = () =>
  worker.withJobTx(live.id, async (tx) => {
    const res = await tx.execute<{ purged: string; tombstoned: string }>(
      sql`select purged, tombstoned from app_purge_audit_events()`,
    );
    return { purged: Number(res.rows[0]?.purged), tombstoned: Number(res.rows[0]?.tombstoned) };
  });

describe("app_purge_audit_events", () => {
  it("purges > 2 years, tombstones deleted households, drops tombstones > 1 year", async () => {
    const first = await purge();
    expect(first.purged).toBeGreaterThanOrEqual(3);
    expect(first.tombstoned).toBeGreaterThanOrEqual(1);

    expect(await read("liveOld")).toBeUndefined();
    expect(await read("deletedOld")).toBeUndefined();
    expect(await read("oldTombstone")).toBeUndefined();

    expect(await read("liveRecent")).toMatchObject({
      household_id: live.id,
      actor_user_id: live.creator.id,
      metadata: { field: "name" },
      ip: "10.0.0.1",
      tombstoned: false,
    });
    expect(await read("userLevel")).toMatchObject({ actor_user_id: live.creator.id, tombstoned: false });
    expect(await read("freshTombstone")).toMatchObject({ tombstoned: true });

    expect(await read("deletedRecent")).toMatchObject({
      household_id: deletedHousehold,
      action: "item.updated",
      actor_user_id: null,
      entity_type: null,
      entity_id: null,
      metadata: {},
      ip: null,
      user_agent: null,
      tombstoned: true,
    });
  });

  it("is idempotent", async () => {
    const before = await read("deletedRecent");
    await purge();
    expect(await read("deletedRecent")).toEqual(before);
    expect(await read("liveRecent")).toBeDefined();
  });

  it("only mp_worker may execute it", async () => {
    await expectDenied(() =>
      api.withHouseholdTx({ userId: live.creator.id }, (tx) =>
        tx.execute(sql`select * from app_purge_audit_events()`),
      ),
    );
  });
});
