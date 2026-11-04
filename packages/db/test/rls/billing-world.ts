// WP-25 rows for the RLS world: a queued billing event (handed over through the API's only path, the
// `app_billing_ingest` function) and a subscription (written by the worker, as `billing.sync` does).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb, type ApiDb } from "../../src/tx";

export interface BillingWorldRows {
  eventId: string;
}

export async function seedBillingWorld(db: ApiDb, householdId: string): Promise<BillingWorldRows> {
  const eventId = `evt_${randomUUID()}`;
  await db.withHouseholdTx({ userId: null }, (tx) =>
    tx.execute(sql`select app_billing_ingest('fake', ${eventId}, ${householdId}::uuid, 'subscription.updated',
      '2026-11-03T10:00:00Z'::timestamptz,
      '{"subscription":{"providerCustomerId":"c","providerSubscriptionId":"s","status":"active","interval":"month"}}'::jsonb)`),
  );
  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(householdId, (tx) =>
      tx.execute(sql`insert into subscriptions
          (household_id, provider, provider_customer_id, provider_subscription_id, status, billing_interval,
           current_period_end, last_event_at)
        values (${householdId}, 'fake', ${`cus_${randomUUID()}`}, ${`sub_${randomUUID()}`}, 'active', 'month',
          '2026-12-04T00:00:00Z', '2026-11-03T09:00:00Z')`),
    );
  } finally {
    await worker.close();
  }
  return { eventId };
}
