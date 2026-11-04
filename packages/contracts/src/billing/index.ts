// Billing contracts (BACKEND_PLAN §7.10, §8.2): plan state, checkout, portal, and the entitlements the
// summary carries. Feature keys mirror `FEATURES` in @mp/billing (a test in apps/api keeps them equal).
import { z } from "zod";
import { Timestamp } from "../common";

export const PlanName = z.enum(["free", "family_plus"]);

export const ENTITLEMENT_FEATURES = [
  "partnerSharing",
  "goals",
  "reminders",
  "emailConnections",
  "renewalAlerts",
  "unlimitedItems",
] as const;

const FeatureAccess = z.object({
  read: z.literal(true).describe("A downgrade never hides data"),
  write: z
    .boolean()
    .describe("False: the feature is read-only on this plan (writes answer entitlement_required)"),
});

export const Entitlements = z
  .object({
    plan: PlanName,
    maxAdults: z.number().int().min(1),
    features: z.object(
      Object.fromEntries(ENTITLEMENT_FEATURES.map((f) => [f, FeatureAccess])) as Record<
        (typeof ENTITLEMENT_FEATURES)[number],
        typeof FeatureAccess
      >,
    ),
    limits: z.object({ items: z.number().int().min(0).nullable() }),
  })
  .meta({ id: "Entitlements" });
export type Entitlements = z.infer<typeof Entitlements>;

export const BillingState = z
  .object({
    plan: PlanName,
    /** Null when the household never subscribed. */
    status: z.enum(["trialing", "active", "past_due", "canceled", "expired"]).nullable(),
    interval: z.enum(["month", "year"]).nullable(),
    currentPeriodEnd: Timestamp.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** Whether the caller is the billing owner (the creator, transferable) and may manage billing. */
    isBillingOwner: z.boolean(),
    /** False while no billing provider is configured: checkout and portal answer 503. */
    available: z.boolean(),
    entitlements: Entitlements,
  })
  .meta({ id: "BillingState" });
export type BillingState = z.infer<typeof BillingState>;

export const CheckoutBody = z
  .object({ interval: z.enum(["month", "year"]) })
  .strict()
  .meta({ id: "CheckoutBody" });
export type CheckoutBody = z.infer<typeof CheckoutBody>;

/** A provider-hosted page. Short-lived; never stored in an idempotency record. */
export const BillingUrl = z.object({ url: z.url() }).meta({ id: "BillingUrl" });
export type BillingUrl = z.infer<typeof BillingUrl>;
