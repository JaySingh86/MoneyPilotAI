// Picks the provider from configuration. No real provider exists yet (H-01), so the only choices are the
// fake (never in production) and none.
import { createFakeProvider } from "./fake";
import type { BillingProvider } from "./provider";

export interface BillingEnv {
  NODE_ENV?: string | undefined;
  /** `fake` (development and tests only) or unset. */
  BILLING_PROVIDER?: string | undefined;
  /** HMAC secret for the fake provider's webhooks. Dev-only value; never commit one. */
  BILLING_WEBHOOK_SECRET?: string | undefined;
}

/**
 * Returns null when no provider is configured: billing routes then answer that billing is unavailable.
 * Throws on a misconfiguration so the process fails to boot instead of running without the billing it was
 * asked to have: an unknown provider name, or the fake anywhere but development and test (an unset or
 * unrecognized NODE_ENV counts as "not development").
 */
export function createProviderFromEnv(env: BillingEnv): BillingProvider | null {
  const name = env.BILLING_PROVIDER;
  if (name === undefined || name === "") return null;
  if (name !== "fake") throw new Error(`BILLING_PROVIDER "${name}" is unknown.`);
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new Error("BILLING_PROVIDER=fake is not allowed outside development and test.");
  }
  return createFakeProvider({ webhookSecret: env.BILLING_WEBHOOK_SECRET });
}
