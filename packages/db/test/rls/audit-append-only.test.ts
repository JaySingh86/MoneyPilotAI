// audit_events is INSERT-only for app roles (BACKEND_PLAN §5.3, WP-03 acceptance).
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, WorkerDb } from "../../src/tx";
import { count, expectDenied, openDbs } from "./helpers";
import { buildHousehold, type TestHousehold } from "./world";

let api: ApiDb;
let worker: WorkerDb;
let hh: TestHousehold;

beforeAll(async () => {
  ({ api, worker } = openDbs());
  hh = await buildHousehold(api, "audit");
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("audit_events is append-only for app roles", () => {
  const attempts = {
    update: sql`update audit_events set action = 'tampered'`,
    "update metadata": sql`update audit_events set metadata = '{}'::jsonb`,
    delete: sql`delete from audit_events`,
    truncate: sql`truncate audit_events`,
  };

  it.each(Object.entries(attempts))(
    "mp_api: %s on own household's events is rejected",
    async (_name, statement) => {
      await expectDenied(() =>
        api.withHouseholdTx({ userId: hh.creator.id, householdId: hh.id }, (tx) => tx.execute(statement)),
      );
    },
  );

  it.each(Object.entries(attempts))(
    "mp_worker: %s on its household's events is rejected",
    async (_name, statement) => {
      await expectDenied(() => worker.withJobTx(hh.id, (tx) => tx.execute(statement)));
    },
  );

  it("the events are still all there and untouched", async () => {
    const n = await api.withHouseholdTx({ userId: hh.partner.id }, (tx) =>
      count(tx, sql`select 1 from audit_events where household_id = ${hh.id} and action <> 'tampered'`),
    );
    // household.created, 2 × invite.created, invite.accepted
    expect(n).toBe(4);
  });

  it("both roles can append", async () => {
    await api.withHouseholdTx({ userId: hh.creator.id }, (tx) =>
      tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action)
        values (${hh.id}, ${hh.creator.id}, 'user', 'test.api')`),
    );
    await worker.withJobTx(hh.id, (tx) =>
      tx.execute(
        sql`insert into audit_events (household_id, actor_type, action) values (${hh.id}, 'system', 'test.worker')`,
      ),
    );
  });

  it("the API cannot forge the actor", async () => {
    await expectDenied(() =>
      api.withHouseholdTx({ userId: hh.creator.id }, (tx) =>
        tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action)
          values (${hh.id}, ${hh.partner.id}, 'user', 'forged')`),
      ),
    );
    await expectDenied(() =>
      api.withHouseholdTx({ userId: hh.creator.id }, (tx) =>
        tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action)
          values (${hh.id}, ${hh.creator.id}, 'system', 'forged')`),
      ),
    );
  });
});
