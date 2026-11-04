// SQL for the billing module. Reads only: every billing write is the worker's (`households.plan`,
// `subscriptions`) or the `app_billing_ingest` function's (the webhook inbox).
import { sql } from "drizzle-orm";
import { AppError } from "@mp/contracts";
import type { Tx } from "@mp/db";
import { INSUFFICIENT_PRIVILEGE, pgErrorOf } from "../identity/db-errors";

export interface SubscriptionView {
  status: "trialing" | "active" | "past_due" | "canceled" | "expired";
  interval: "month" | "year";
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  providerCustomerId: string;
}

export async function getPlan(tx: Tx, householdId: string): Promise<"free" | "family_plus" | null> {
  const res = await tx.execute<{ plan: "free" | "family_plus" }>(
    sql`select plan from households where id = ${householdId}`,
  );
  return res.rows[0]?.plan ?? null;
}

export async function getSubscription(tx: Tx, householdId: string): Promise<SubscriptionView | null> {
  const res = await tx.execute<{
    status: SubscriptionView["status"];
    billing_interval: SubscriptionView["interval"];
    current_period_end: Date | null;
    cancel_at_period_end: boolean;
    provider_customer_id: string;
  }>(
    sql`select status, billing_interval, current_period_end, cancel_at_period_end, provider_customer_id
          from subscriptions where household_id = ${householdId}`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    interval: row.billing_interval,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    providerCustomerId: row.provider_customer_id,
  };
}

/** True when `userId` is the household's active creator, who is the billing owner (BACKEND_PLAN §6). */
export async function isBillingOwner(tx: Tx, householdId: string, userId: string): Promise<boolean> {
  const res = await tx.execute(
    sql`select 1 from household_members
         where household_id = ${householdId} and user_id = ${userId} and is_creator and left_at is null`,
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getUserEmail(tx: Tx, userId: string): Promise<string | null> {
  const res = await tx.execute<{ email: string }>(
    sql`select email::text as email from users where id = ${userId}`,
  );
  return res.rows[0]?.email ?? null;
}

/** The webhook's one write: record the event id and queue the normalized event for the worker. */
export async function ingestEvent(
  tx: Tx,
  event: {
    provider: string;
    eventId: string;
    householdId: string;
    type: string;
    occurredAt: string;
    payload: object;
  },
): Promise<boolean> {
  let res;
  try {
    res = await tx.execute<{ isNew: boolean }>(
      sql`select app_billing_ingest(${event.provider}, ${event.eventId}, ${event.householdId}::uuid, ${event.type},
          ${event.occurredAt}::timestamptz, ${JSON.stringify(event.payload)}::jsonb) as "isNew"`,
    );
  } catch (err) {
    // Signed, but not something a provider would send (a far-future date, an unknown shape): refuse it.
    const pg = pgErrorOf(err);
    if (pg?.code === INSUFFICIENT_PRIVILEGE && pg.message === "billing_event_invalid") {
      throw new AppError("validation_failed", 400, "The webhook event was refused.");
    }
    throw err;
  }
  return res.rows[0]?.isNew === true;
}
