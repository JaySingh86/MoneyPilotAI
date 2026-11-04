// Applies a household's queued billing events (WP-25, BACKEND_PLAN §7.10, `billing.sync`). Runs as mp_worker
// inside a job scoped to one household: the only role that may write `subscriptions` and `households.plan`.
//
// This package does not import @mp/billing (adapters never import each other, ARCHITECTURE §3), so the job
// passes in how to read a stored snapshot and which plan it pays for.
import { sql } from "drizzle-orm";
import type { Tx } from "../tx";

export type BillingStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";

/** What the database keeps of a provider's subscription. */
export interface StoredSubscription {
  providerCustomerId: string;
  providerSubscriptionId: string;
  status: BillingStatus;
  interval: "month" | "year";
  /** ISO 8601 UTC. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingSyncDeps {
  nowMs: number;
  /** Validates the `subscription` stored in an event's payload; throws on a bad shape. */
  parseSnapshot(raw: unknown): StoredSubscription;
  /** The plan a subscription pays for right now (`planFor` in @mp/billing). */
  planFor(subscription: StoredSubscription | null, nowMs: number): "free" | "family_plus";
}

export interface BillingSyncResult {
  applied: number;
  stale: number;
  ignored: number;
  plan: "free" | "family_plus";
  planChanged: boolean;
}

type Outcome = "applied" | "stale" | "ignored";

interface EventRow extends Record<string, unknown> {
  id: string;
  provider: string;
  event_id: string;
  occurred_at: Date | string;
  received_at: Date | string;
  payload: { subscription?: unknown };
}

interface SubscriptionRow extends Record<string, unknown> {
  provider: string;
  provider_customer_id: string;
  provider_subscription_id: string;
  status: BillingStatus;
  billing_interval: "month" | "year";
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  last_event_at: Date | string;
}

function toStored(row: SubscriptionRow): StoredSubscription {
  return {
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    status: row.status,
    interval: row.billing_interval,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

/** SQLSTATE class 22 (data) or 23 (integrity): a fault of this one event's data, not of the connection. */
function isDataFault(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Applies one event to the subscription row. `at` is the event's effective time: the earlier of what the
 * provider claims and when we received it, so a forged future date cannot make later real events look
 * stale (review M2).
 */
async function applyOne(
  tx: Tx,
  householdId: string,
  event: EventRow,
  snapshot: StoredSubscription,
  at: Date,
): Promise<"applied" | "stale"> {
  const current = await tx.execute<SubscriptionRow>(
    sql`select * from subscriptions where household_id = ${householdId} for update`,
  );
  const existing = current.rows[0];
  if (existing) {
    const newer = at.getTime() > new Date(existing.last_event_at).getTime();
    if (snapshot.providerSubscriptionId === existing.provider_subscription_id) {
      if (!newer && at.getTime() < new Date(existing.last_event_at).getTime()) return "stale";
    } else {
      // Another subscription id: a replacement only if it is live and newer. A late `expired` or `canceled`
      // for an old subscription must not downgrade a household that pays for the current one (review M3).
      const live = snapshot.status === "active" || snapshot.status === "trialing";
      if (!live || !newer) return "stale";
    }
    await tx.execute(
      sql`update subscriptions
             set provider = ${event.provider}, provider_customer_id = ${snapshot.providerCustomerId},
                 provider_subscription_id = ${snapshot.providerSubscriptionId}, status = ${snapshot.status},
                 billing_interval = ${snapshot.interval}, current_period_end = ${snapshot.currentPeriodEnd},
                 cancel_at_period_end = ${snapshot.cancelAtPeriodEnd},
                 last_event_at = ${at.toISOString()}::timestamptz, updated_at = now()
           where household_id = ${householdId}`,
    );
    return "applied";
  }
  await tx.execute(
    sql`insert into subscriptions (household_id, provider, provider_customer_id, provider_subscription_id,
          status, billing_interval, current_period_end, cancel_at_period_end, last_event_at)
        values (${householdId}, ${event.provider}, ${snapshot.providerCustomerId},
          ${snapshot.providerSubscriptionId}, ${snapshot.status}, ${snapshot.interval},
          ${snapshot.currentPeriodEnd}, ${snapshot.cancelAtPeriodEnd}, ${at.toISOString()}::timestamptz)`,
  );
  return "applied";
}

/**
 * Idempotent: only unprocessed events are touched and each is marked processed in the same transaction.
 * Events are applied oldest first, each in its own savepoint: one that fails on its data (a constraint, a
 * bad value) is marked `ignored` and the rest still apply, so a poison event never blocks a household
 * (review M3). Stale and out-of-order events are marked `stale`. Afterwards the plan is recomputed from the
 * stored subscription, so a canceled subscription whose period has ended also drops to Free without a new
 * event.
 */
export async function applyBillingEvents(
  tx: Tx,
  householdId: string,
  deps: BillingSyncDeps,
): Promise<BillingSyncResult> {
  const events = await tx.execute<EventRow>(
    sql`select id, provider, event_id, occurred_at, received_at, payload from billing_events
         where household_id = ${householdId} and processed_at is null
         order by least(occurred_at, received_at), received_at, id
           for update`,
  );

  const counts: Record<Outcome, number> = { applied: 0, stale: 0, ignored: 0 };
  for (const event of events.rows) {
    let outcome: Outcome;
    let snapshot: StoredSubscription | null = null;
    try {
      snapshot = deps.parseSnapshot(event.payload.subscription);
    } catch {
      snapshot = null;
    }
    if (!snapshot) {
      outcome = "ignored";
    } else {
      const at = new Date(
        Math.min(new Date(event.occurred_at).getTime(), new Date(event.received_at).getTime()),
      );
      const parsed = snapshot;
      try {
        outcome = await tx.transaction(async (savepoint) =>
          applyOne(savepoint as unknown as Tx, householdId, event, parsed, at),
        );
      } catch (err) {
        if (!isDataFault(err)) throw err;
        outcome = "ignored";
      }
    }
    counts[outcome]++;
    await tx.execute(
      sql`update billing_events set processed_at = now(), outcome = ${outcome} where id = ${event.id}`,
    );
    await tx.execute(
      sql`update webhook_events set processed_at = now()
           where provider = ${event.provider} and event_id = ${event.event_id} and processed_at is null`,
    );
  }

  const latest = await tx.execute<SubscriptionRow>(
    sql`select * from subscriptions where household_id = ${householdId}`,
  );
  const stored = latest.rows[0] ? toStored(latest.rows[0]) : null;
  const plan = deps.planFor(stored, deps.nowMs);
  // Only households that have a subscription row are managed here: a household with none keeps whatever the
  // worker set before (seeded or granted plans are not downgraded by an empty sync).
  let planChanged = false;
  if (stored) {
    const updated = await tx.execute(
      sql`update households set plan = ${plan} where id = ${householdId} and plan <> ${plan}`,
    );
    planChanged = (updated.rowCount ?? 0) > 0;
  }
  return { ...counts, plan, planChanged };
}
