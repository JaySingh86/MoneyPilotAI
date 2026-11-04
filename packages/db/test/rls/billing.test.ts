// WP-25: the billing write path. `households.plan` stays mp_worker-only; the API reaches the worker only through
// `app_billing_ingest`, which dedupes through webhook_events. Cross-household isolation of subscriptions and
// billing_events is in household-isolation.test.ts (cases.ts).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectReason, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asAnon = <T>(fn: (tx: Tx) => Promise<T>) => api.withHouseholdTx({ userId: null }, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

const VALID_PAYLOAD = JSON.stringify({
  subscription: {
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    status: "active",
    interval: "month",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  },
});

const ingest = (tx: Tx, eventId: string, householdId: string) =>
  tx.execute<{ new: boolean }>(sql`select app_billing_ingest('fake', ${eventId}, ${householdId}::uuid,
    'subscription.updated', '2026-11-03T10:00:00Z'::timestamptz, ${VALID_PAYLOAD}::jsonb) as new`);

describe("households.plan is writable by the worker only", () => {
  it("mp_api cannot set the plan, even for its own household", async () => {
    await expectDenied(() => asA((tx) => tx.execute(sql`update households set plan = 'family_plus'`)));
  });

  it("mp_worker can, for its own household only", async () => {
    await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`update households set plan = 'family_plus' where id = ${world.a.id}`),
    );
    const other = await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`update households set plan = 'free' where id = ${world.b.id}`),
    );
    expect(other.rowCount).toBe(0);
    const plan = await asA((tx) => tx.execute<{ plan: string }>(sql`select plan from households`));
    expect(plan.rows[0]?.plan).toBe("family_plus");
    await worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`update households set plan = 'free' where id = ${world.a.id}`),
    );
  });
});

describe("app_billing_ingest", () => {
  it("queues a new event and ignores a repeat of the same provider event id", async () => {
    const eventId = `evt_${randomUUID()}`;
    const first = await asAnon((tx) => ingest(tx, eventId, world.a.id));
    const again = await asAnon((tx) => ingest(tx, eventId, world.a.id));
    expect(first.rows[0]?.new).toBe(true);
    expect(again.rows[0]?.new).toBe(false);
    const queued = await worker.withJobTx(world.a.id, (tx) =>
      count(tx, sql`select 1 from billing_events where event_id = ${eventId}`),
    );
    expect(queued).toBe(1);
  });

  it("marks an event for an unknown household processed and queues nothing", async () => {
    const eventId = `evt_${randomUUID()}`;
    const res = await asAnon((tx) => ingest(tx, eventId, randomUUID()));
    expect(res.rows[0]?.new).toBe(true);
    const processed = await worker.withJobTx(world.a.id, (tx) =>
      tx.execute<{ processed_at: string | null }>(
        sql`select processed_at from webhook_events where provider = 'fake' and event_id = ${eventId}`,
      ),
    );
    expect(processed.rows[0]?.processed_at).not.toBeNull();
  });

  it("is the API's only write path: no direct insert or update of billing_events or subscriptions", async () => {
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into billing_events (household_id, provider, event_id, type, occurred_at, payload)
          values (${world.a.id}, 'fake', 'direct', 'x', now(), '{}'::jsonb)`),
      ),
    );
    await expectDenied(() => asA((tx) => tx.execute(sql`update billing_events set outcome = 'applied'`)));
    await expectDenied(() => asA((tx) => tx.execute(sql`update subscriptions set status = 'active'`)));
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into subscriptions (household_id, provider, provider_customer_id,
          provider_subscription_id, status, billing_interval, last_event_at)
          values (${world.a.id}, 'fake', 'c', 's', 'active', 'month', now())`),
      ),
    );
  });

  it("is executable by mp_api only, and the pending list by mp_worker only", async () => {
    await expectDenied(() =>
      worker.withJobTx(world.a.id, (tx) => ingest(tx, `evt_${randomUUID()}`, world.a.id)),
    );
    await expectDenied(() => asA((tx) => tx.execute(sql`select app_billing_pending_households()`)));
    const pending = await worker.withJobTx(world.a.id, (tx) =>
      tx.execute<{ id: string }>(sql`select app_billing_pending_households() as id`),
    );
    expect(pending.rows.map((r) => r.id)).toContain(world.a.id);
  });
});

describe("app_billing_ingest refuses what a verified provider would not send (M2)", () => {
  const call = (type: string, occurredAt: string, payload: string) =>
    asAnon((tx) =>
      tx.execute(sql`select app_billing_ingest('fake', ${`evt_${randomUUID()}`}, ${world.a.id}::uuid, ${type},
        ${occurredAt}::timestamptz, ${payload}::jsonb)`),
    );

  it("rejects an occurred_at more than 5 minutes in the future, accepts one just inside", async () => {
    const far = new Date(Date.now() + 60 * 60_000).toISOString();
    await expectReason(() => call("subscription.updated", far, VALID_PAYLOAD), "billing_event_invalid");
    const near = new Date(Date.now() + 2 * 60_000).toISOString();
    await call("subscription.updated", near, VALID_PAYLOAD);
  });

  it("rejects unknown type shapes and payload shapes", async () => {
    const past = "2026-11-03T10:00:00Z";
    await expectReason(() => call("Not A Type!", past, VALID_PAYLOAD), "billing_event_invalid");
    await expectReason(() => call("x".repeat(81), past, VALID_PAYLOAD), "billing_event_invalid");
    for (const bad of [
      "{}",
      "[]",
      '{"subscription":[]}',
      '{"subscription":{"status":"gold","interval":"month","providerCustomerId":"c","providerSubscriptionId":"s"}}',
      '{"subscription":{"status":"active","interval":"week","providerCustomerId":"c","providerSubscriptionId":"s"}}',
      '{"subscription":{"status":"active","interval":"month","providerCustomerId":"","providerSubscriptionId":"s"}}',
      '{"subscription":{"status":"active","interval":"month","providerCustomerId":"c"}}',
    ]) {
      await expectReason(() => call("subscription.updated", past, bad), "billing_event_invalid");
    }
  });
});

describe("subscriptions constraints", () => {
  it("rejects an unknown status and a second subscription row for the same household", async () => {
    await expectRejected(
      () =>
        worker.withJobTx(world.a.id, (tx) =>
          tx.execute(sql`update subscriptions set status = 'gold' where household_id = ${world.a.id}`),
        ),
      "23514",
    );
    await expectRejected(
      () =>
        worker.withJobTx(world.a.id, (tx) =>
          tx.execute(sql`insert into subscriptions (household_id, provider, provider_customer_id,
            provider_subscription_id, status, billing_interval, last_event_at)
            values (${world.a.id}, 'fake', 'c', 's', 'active', 'month', now())`),
        ),
      "23505",
    );
  });
});
