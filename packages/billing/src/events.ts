// The provider-neutral shape of a billing webhook and the rule that turns a subscription into a plan.
// A provider adapter maps its own payloads to `BillingEvent`; everything after that is provider-free.
import { z } from "zod";
import type { Plan } from "./features";

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const SubscriptionSnapshot = z.object({
  providerCustomerId: z.string().min(1).max(120),
  providerSubscriptionId: z.string().min(1).max(120),
  status: z.enum(SUBSCRIPTION_STATUSES),
  interval: z.enum(BILLING_INTERVALS),
  /** End of the paid period, ISO 8601 UTC; null when the provider gives none. */
  currentPeriodEnd: z.iso.datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});
export type SubscriptionSnapshot = z.infer<typeof SubscriptionSnapshot>;

/** A verified, normalized webhook. Holds ids and states only: no card data, names or amounts. */
export const BillingEvent = z.object({
  provider: z.string().min(1).max(40),
  /** The provider's event id: the idempotency key in `webhook_events`. */
  eventId: z.string().min(1).max(200),
  type: z.string().min(1).max(80),
  /** Carried through checkout as custom data. Events without one cannot be applied. */
  householdId: z.uuid(),
  occurredAt: z.iso.datetime(),
  subscription: SubscriptionSnapshot,
});
export type BillingEvent = z.infer<typeof BillingEvent>;

/**
 * The plan a subscription pays for at `nowMs`. Past due keeps Plus while the provider retries payment (it
 * sends `canceled` or `expired` when it gives up); a canceled subscription keeps Plus to the end of the period
 * the household already paid for.
 */
export function planFor(subscription: SubscriptionSnapshot | null, nowMs: number): Plan {
  if (!subscription) return "free";
  switch (subscription.status) {
    case "trialing":
    case "active":
    case "past_due":
      return "family_plus";
    case "canceled": {
      if (!subscription.currentPeriodEnd) return "free";
      return Date.parse(subscription.currentPeriodEnd) > nowMs ? "family_plus" : "free";
    }
    case "expired":
      return "free";
  }
}
