// Billing module (WP-25): plan state, checkout and portal for the billing owner, the provider webhook, and the
// entitlement gate other modules attach to their Plus routes (`requireEntitlement`).
import { createProviderFromEnv, type BillingProvider, type WebhookVerifier } from "@mp/billing";
import { defineModule, WEBHOOKS_PREFIX, type ApiModule } from "../../lib/module";
import { assertFreshTimestamp, verifyHmacSignature } from "../../lib/webhooks";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { billingRoutes, billingWebhookRoutes } from "./routes";
import type { BillingDeps } from "./service";

export { requireEntitlement, type EntitlementSource } from "./guard";

/** WP-08's generic HMAC helper and replay window, handed to the provider adapter. */
export const webhookVerifier: WebhookVerifier = {
  hmac: (input) => verifyHmacSignature(input),
  fresh: (timestampSeconds, nowMs) => {
    try {
      assertFreshTimestamp(timestampSeconds, nowMs);
      return true;
    } catch {
      return false;
    }
  },
};

export interface BillingOptions {
  /** Default: from BILLING_PROVIDER / BILLING_WEBHOOK_SECRET at the first request (null when unset). */
  provider?: BillingProvider | null;
  /** UTC instant as ISO 8601. */
  now?: () => string;
}

export function createBillingModules(
  source: RuntimeSource = runtime,
  options: BillingOptions = {},
): readonly ApiModule[] {
  const now = options.now ?? (() => new Date().toISOString());
  let fromEnv: BillingProvider | null | undefined;
  const provider = (): BillingProvider | null => {
    if (options.provider !== undefined) return options.provider;
    fromEnv ??= createProviderFromEnv(process.env);
    return fromEnv;
  };
  const deps = (): BillingDeps => ({
    db: source().db,
    provider: provider(),
    verifier: webhookVerifier,
    now,
  });
  return [
    defineModule({ name: "billing", routes: billingRoutes(deps, () => source().provider) }),
    defineModule({ name: "billing-webhook", prefix: WEBHOOKS_PREFIX, routes: billingWebhookRoutes(deps) }),
  ];
}

export const billingModules = createBillingModules();
