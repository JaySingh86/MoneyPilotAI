// @mp/billing: the billing adapter (ADR-013), the entitlement map and the subscription-to-plan rule (WP-25).
export {
  DEFAULT_ENTITLEMENT_CONFIG,
  DEFAULT_FEATURE_TIERS,
  FEATURES,
  MAX_ADULTS,
  PLANS,
  canWrite,
  entitlementsForPlan,
  type EntitlementConfig,
  type Entitlements,
  type Feature,
  type FeatureAccess,
  type Plan,
  type Tier,
} from "./features";
export {
  BILLING_INTERVALS,
  BillingEvent,
  SUBSCRIPTION_STATUSES,
  SubscriptionSnapshot,
  planFor,
  type BillingInterval,
  type SubscriptionStatus,
} from "./events";
export {
  BillingWebhookError,
  type BillingProvider,
  type CheckoutInput,
  type PortalInput,
  type WebhookFailure,
  type WebhookInput,
  type WebhookVerifier,
} from "./provider";
export {
  FAKE_PROVIDER_ID,
  FAKE_SIGNATURE_HEADER,
  FAKE_TIMESTAMP_HEADER,
  createFakeProvider,
  signFakeWebhook,
  type FakeProviderOptions,
  type FakeWebhookBody,
} from "./fake";
export { createProviderFromEnv, type BillingEnv } from "./env";
