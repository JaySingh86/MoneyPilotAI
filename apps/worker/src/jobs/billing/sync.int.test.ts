// billing.drain and billing.sync against a real Postgres as mp_api / mp_worker: the drain finds households
// with queued events (and those whose plan lags an ended subscription), the sync applies them under the
// household's scope, and a second run changes nothing.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import pg from "pg";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "@mp/db";
import { createHousehold, ensureUser } from "@mp/db/testing";
import type { JobSender } from "../plan/recompute";
import { BILLING_SYNC_QUEUE, handleBillingDrain, handleBillingSync } from "./sync";

let api: ApiDb;
let worker: WorkerDb;
let apiSql: pg.Client; // mp_api, for the one function it may call
let admin: pg.Client;
const deps = () => ({ db: worker, now: () => "2026-11-04T12:00:00Z" });

beforeAll(() => {
  api = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 2 });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  apiSql = new pg.Client({ connectionString: inject("apiDatabaseUrl") });
  admin = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  return Promise.all([apiSql.connect(), admin.connect()]).then(() => undefined);
});
afterAll(async () => {
  // Leave no households behind: the nightly sweep test in boss.int.test.ts counts jobs per household.
  await admin?.query("delete from households where id = any($1::uuid[])", [created]);
  await apiSql?.end();
  await admin?.end();
  await api?.close();
  await worker?.close();
});

const created: string[] = [];
async function newHousehold(): Promise<string> {
  const id = randomUUID();
  created.push(id);
  const owner = await ensureUser(api, {
    authSubject: `billing|${id}`,
    email: `${id}@example.test`,
    firstName: "Bill",
    timezone: "America/New_York",
  });
  await createHousehold(api, owner, {
    id,
    name: "Billing household",
    timezone: "America/New_York",
    forwardingToken: `bill-${id.slice(0, 8)}`,
  });
  return id;
}

const subscription = (status: string, periodEnd: string | null, subscriptionId = `sub_${randomUUID()}`) => ({
  subscription: {
    providerCustomerId: "cus_1",
    providerSubscriptionId: subscriptionId,
    status,
    interval: "month",
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
  },
});

const ingest = (householdId: string, payload: object, occurredAt = "2026-11-03T11:00:00Z") =>
  apiSql.query(
    `select app_billing_ingest('fake', $1, $2::uuid, 'subscription.updated', $3::timestamptz, $4::jsonb)`,
    [`evt_${randomUUID()}`, householdId, occurredAt, JSON.stringify(payload)],
  );

const planOf = async (householdId: string) =>
  (await admin.query<{ plan: string }>("select plan from households where id = $1", [householdId])).rows[0]
    ?.plan;

function collector(): { sender: JobSender; sent: { household: string; key: string | undefined }[] } {
  const sent: { household: string; key: string | undefined }[] = [];
  return {
    sent,
    sender: {
      async send(name, data, options) {
        expect(name).toBe(BILLING_SYNC_QUEUE);
        sent.push({ household: (data as { householdId: string }).householdId, key: options?.singletonKey });
        return "job";
      },
    },
  };
}

describe("billing.drain and billing.sync", () => {
  it("drain enqueues one sync per household with a queued event, keyed per household", async () => {
    const hh = await newHousehold();
    await ingest(hh, subscription("active", "2026-12-04T00:00:00Z"));
    const { sender, sent } = collector();
    await handleBillingDrain({ db: worker, sender });
    const mine = sent.filter((s) => s.household === hh);
    expect(mine).toEqual([{ household: hh, key: `billing.sync:${hh}` }]);
  });

  it("sync upgrades the plan, is idempotent, and leaves the household out of the next drain", async () => {
    const hh = await newHousehold();
    await ingest(hh, subscription("active", "2026-12-04T00:00:00Z"));
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({
      applied: 1,
      plan: "family_plus",
      planChanged: true,
    });
    expect(await planOf(hh)).toBe("family_plus");
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({
      applied: 0,
      planChanged: false,
    });
    const { sender, sent } = collector();
    await handleBillingDrain({ db: worker, sender });
    expect(sent.filter((s) => s.household === hh)).toEqual([]);
  });

  it("a canceled subscription whose period has ended is picked up by the drain without a new webhook", async () => {
    // The drain compares with the database clock, so this uses real time: paid through one second from now.
    const hh = await newHousehold();
    const realNow = new Date();
    await ingest(hh, subscription("canceled", new Date(realNow.getTime() + 1000).toISOString()));
    const during = { db: worker, now: () => realNow.toISOString() };
    await handleBillingSync(during, { householdId: hh });
    expect(await planOf(hh)).toBe("family_plus"); // still inside the paid period
    const first = collector();
    await handleBillingDrain({ db: worker, sender: first.sender });
    expect(first.sent.map((s) => s.household)).not.toContain(hh);

    await new Promise((r) => setTimeout(r, 1500));
    const second = collector();
    await handleBillingDrain({ db: worker, sender: second.sender });
    expect(second.sent.map((s) => s.household)).toContain(hh);
    const after = { db: worker, now: () => new Date().toISOString() };
    expect(await handleBillingSync(after, { householdId: hh })).toMatchObject({
      plan: "free",
      planChanged: true,
    });
    expect(await planOf(hh)).toBe("free");
  });

  it("a malformed stored payload is ignored, not retried forever", async () => {
    const hh = await newHousehold();
    // Ingest refuses this shape, so put it in the inbox directly (as a bug or an old row could).
    await admin.query(
      `insert into billing_events (household_id, provider, event_id, type, occurred_at, payload)
       values ($1, 'fake', $2, 'subscription.updated', '2026-11-03T11:00:00Z', '{"subscription":{"status":"gold"}}')`,
      [hh, `evt_${randomUUID()}`],
    );
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({ ignored: 1, applied: 0 });
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({ ignored: 0 });
  });

  it("M3 a poison event is ignored in its own savepoint and later events still apply", async () => {
    const taken = await newHousehold();
    const sharedSub = `sub_${randomUUID()}`;
    await ingest(taken, subscription("active", "2026-12-04T00:00:00Z", sharedSub));
    await handleBillingSync(deps(), { householdId: taken });

    // The same provider subscription id for another household violates the unique key: the apply fails.
    const hh = await newHousehold();
    await ingest(hh, subscription("active", "2026-12-04T00:00:00Z", sharedSub), "2026-11-03T10:00:00Z");
    await ingest(hh, subscription("active", "2026-12-04T00:00:00Z"), "2026-11-03T10:30:00Z");
    const result = await handleBillingSync(deps(), { householdId: hh });
    expect(result).toMatchObject({ ignored: 1, applied: 1, plan: "family_plus", planChanged: true });
    expect(await planOf(hh)).toBe("family_plus");
    const outcomes = await admin.query<{ outcome: string }>(
      "select outcome from billing_events where household_id = $1 order by occurred_at",
      [hh],
    );
    expect(outcomes.rows.map((r) => r.outcome)).toEqual(["ignored", "applied"]);
    // Nothing is left to retry.
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({ applied: 0, ignored: 0 });
  });

  it("M3 a late event for an old subscription cannot downgrade a paying household", async () => {
    const hh = await newHousehold();
    const current = `sub_${randomUUID()}`;
    await ingest(hh, subscription("active", "2026-12-04T00:00:00Z", current), "2026-11-03T10:00:00Z");
    await handleBillingSync(deps(), { householdId: hh });

    // The old subscription's `expired` arrives later than the current one's event: stale, not applied.
    await ingest(hh, subscription("expired", null, `sub_${randomUUID()}`), "2026-11-03T11:00:00Z");
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({
      stale: 1,
      applied: 0,
      plan: "family_plus",
    });
    expect(await planOf(hh)).toBe("family_plus");

    // A newer active subscription with a different id does replace it.
    const replacement = `sub_${randomUUID()}`;
    await ingest(hh, subscription("active", "2027-01-04T00:00:00Z", replacement), "2026-11-03T12:00:00Z");
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({
      applied: 1,
      plan: "family_plus",
    });
    const row = await admin.query<{ provider_subscription_id: string }>(
      "select provider_subscription_id from subscriptions where household_id = $1",
      [hh],
    );
    expect(row.rows[0]?.provider_subscription_id).toBe(replacement);

    // A non-active status for yet another id still cannot downgrade it.
    await ingest(
      hh,
      subscription("canceled", "2026-11-01T00:00:00Z", `sub_${randomUUID()}`),
      "2026-11-03T13:00:00Z",
    );
    expect(await handleBillingSync(deps(), { householdId: hh })).toMatchObject({
      stale: 1,
      plan: "family_plus",
    });
  });

  it("M2 last_event_at never exceeds the time the event was received", async () => {
    const hh = await newHousehold();
    const soon = new Date(Date.now() + 4 * 60_000).toISOString(); // inside the 5 minute allowance
    await ingest(hh, subscription("active", "2026-12-04T00:00:00Z"), soon);
    await handleBillingSync(deps(), { householdId: hh });
    const stored = await admin.query<{ ok: boolean }>(
      `select s.last_event_at <= b.received_at as ok
         from subscriptions s join billing_events b on b.household_id = s.household_id
        where s.household_id = $1`,
      [hh],
    );
    expect(stored.rows[0]?.ok).toBe(true);
  });

  it("rejects job data without a valid household id", async () => {
    await expect(handleBillingSync(deps(), { householdId: "nope" })).rejects.toThrow();
  });
});
