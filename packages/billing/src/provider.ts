// The billing adapter (ADR-013). A real merchant-of-record provider (H-01, undecided) implements this
// interface; `createFakeProvider` is the only implementation today.
import type { BillingEvent, BillingInterval } from "./events";

/**
 * The API's webhook helpers (apps/api/src/lib/webhooks, WP-08), handed in so this package stays free of app
 * code and a provider cannot skip or reimplement signature checks.
 */
export interface WebhookVerifier {
  /** Constant-time HMAC check of `payload` (the exact raw bytes or the provider's signed string). */
  hmac(input: {
    secret: string;
    payload: string | Buffer;
    signature: string;
    algorithm?: "sha256" | "sha512";
    encoding?: "hex" | "base64";
  }): boolean;
  /** False when a signed timestamp (epoch seconds) is outside the replay window. */
  fresh(timestampSeconds: number, nowMs: number): boolean;
}

export interface CheckoutInput {
  householdId: string;
  interval: BillingInterval;
  /** The billing owner's verified email, to prefill checkout. Never logged. */
  email: string;
}

export interface PortalInput {
  householdId: string;
  providerCustomerId: string;
}

export interface WebhookInput {
  /** The exact bytes received. */
  rawBody: Buffer;
  /** Lower-cased header names. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  nowMs: number;
  verifier: WebhookVerifier;
}

export type WebhookFailure = "signature" | "invalid" | "not_configured";

export class BillingWebhookError extends Error {
  override readonly name = "BillingWebhookError";
  constructor(
    readonly kind: WebhookFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface BillingProvider {
  readonly id: string;
  /** A hosted checkout URL for the household's subscription. The household id travels as custom data. */
  createCheckout(input: CheckoutInput): Promise<{ url: string }>;
  /** The provider's customer portal (payment method, invoices, cancel). */
  portalUrl(input: PortalInput): Promise<{ url: string }>;
  /**
   * Verifies the signature first, then parses. Returns null for a valid event that does not concern a
   * subscription. Throws `BillingWebhookError`.
   */
  handleWebhook(input: WebhookInput): Promise<BillingEvent | null>;
}
