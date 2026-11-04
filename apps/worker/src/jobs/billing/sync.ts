// Jobs `billing.sync` and `billing.drain` (BACKEND_PLAN §7.10, §9). The API cannot enqueue (no queue role yet,
// Q-105), so a verified webhook is left in `billing_events` and `billing.drain` (every minute) finds the
// households with something to apply, plus those whose plan no longer matches an ended subscription. One
// `billing.sync` per household applies the events under that household's scope: the worker is the only role
// that writes `subscriptions` and `households.plan`. Idempotent: processed events are never touched again.
import { z } from "zod";
import { applyBillingEvents, type BillingSyncResult, type WorkerDb } from "@mp/db";
import { SubscriptionSnapshot, planFor } from "@mp/billing";
import type { JobSender } from "../plan/recompute";

export const BILLING_SYNC_QUEUE = "billing.sync";
export const BILLING_DRAIN_QUEUE = "billing.drain";
/** Every minute. */
export const BILLING_DRAIN_CRON = "* * * * *";
/** BACKEND_PLAN §9: 5 attempts with backoff. */
export const BILLING_SYNC_QUEUE_OPTIONS = { retryLimit: 5, retryDelay: 10, retryBackoff: true } as const;

export const BillingSyncJob = z.object({ householdId: z.uuid() });
export type BillingSyncJob = z.infer<typeof BillingSyncJob>;

export interface BillingSyncDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

export async function handleBillingSync(deps: BillingSyncDeps, data: unknown): Promise<BillingSyncResult> {
  const job = BillingSyncJob.parse(data);
  const nowMs = Date.parse(deps.now());
  return deps.db.withJobTx(job.householdId, (tx) =>
    applyBillingEvents(tx, job.householdId, {
      nowMs,
      parseSnapshot: (raw) => SubscriptionSnapshot.parse(raw),
      planFor,
    }),
  );
}

export interface BillingDrainDeps {
  db: WorkerDb;
  sender: JobSender;
}

export async function handleBillingDrain(deps: BillingDrainDeps): Promise<{ households: number }> {
  const ids = await deps.db.listBillingPendingHouseholds();
  for (const householdId of ids) {
    await deps.sender.send(
      BILLING_SYNC_QUEUE,
      { householdId },
      { singletonKey: `${BILLING_SYNC_QUEUE}:${householdId}` },
    );
  }
  return { households: ids.length };
}
