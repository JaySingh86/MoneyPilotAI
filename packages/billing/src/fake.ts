// A deterministic provider for tests and local development. Its webhooks are signed with
// HMAC-SHA256 over `${timestamp}.${rawBody}`, the common shape of merchant-of-record providers, so the
// API's route and the worker are exercised exactly as a real provider would drive them.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { BILLING_INTERVALS, SUBSCRIPTION_STATUSES, type BillingEvent } from "./events";
import { BillingWebhookError, type BillingProvider, type WebhookInput } from "./provider";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
export const FAKE_TIMESTAMP_HEADER = "x-fake-timestamp";

const FakeWebhookBody = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(80),
  occurred_at: z.iso.datetime(),
  data: z.object({
    household_id: z.uuid(),
    customer_id: z.string().min(1).max(120),
    subscription_id: z.string().min(1).max(120),
    status: z.enum(SUBSCRIPTION_STATUSES),
    interval: z.enum(BILLING_INTERVALS),
    current_period_end: z.iso.datetime().nullable(),
    cancel_at_period_end: z.boolean(),
  }),
});
export type FakeWebhookBody = z.infer<typeof FakeWebhookBody>;

export interface FakeProviderOptions {
  /** HMAC secret. Missing: every webhook is refused (fail closed). */
  webhookSecret: string | undefined;
}

function header(headers: WebhookInput["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Signs a body the way the fake provider's "servers" would. Tests and the dev trigger use it. */
export function signFakeWebhook(
  secret: string,
  body: FakeWebhookBody,
  timestampSeconds: number,
): { rawBody: Buffer; headers: Record<string, string> } {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest("hex");
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      [FAKE_SIGNATURE_HEADER]: signature,
      [FAKE_TIMESTAMP_HEADER]: String(timestampSeconds),
    },
  };
}

export function createFakeProvider(options: FakeProviderOptions): BillingProvider {
  return {
    id: FAKE_PROVIDER_ID,

    async createCheckout(input) {
      const query = new URLSearchParams({ household: input.householdId, interval: input.interval });
      return { url: `https://checkout.fake-billing.invalid/pay?${query.toString()}` };
    },

    async portalUrl(input) {
      const query = new URLSearchParams({ customer: input.providerCustomerId });
      return { url: `https://portal.fake-billing.invalid/manage?${query.toString()}` };
    },

    async handleWebhook(input): Promise<BillingEvent | null> {
      if (!options.webhookSecret) throw new BillingWebhookError("not_configured", "No webhook secret.");
      const signature = header(input.headers, FAKE_SIGNATURE_HEADER);
      const timestamp = Number(header(input.headers, FAKE_TIMESTAMP_HEADER));
      if (!signature || !Number.isInteger(timestamp)) {
        throw new BillingWebhookError("signature", "The webhook is unsigned.");
      }
      // The signature comes first: nothing in the body is read before it is proven.
      const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), input.rawBody]);
      if (!input.verifier.hmac({ secret: options.webhookSecret, payload: signedPayload, signature })) {
        throw new BillingWebhookError("signature", "The webhook signature is wrong.");
      }
      if (!input.verifier.fresh(timestamp, input.nowMs)) {
        throw new BillingWebhookError("signature", "The webhook timestamp is outside the window.");
      }
      let json: unknown;
      try {
        json = JSON.parse(input.rawBody.toString("utf8"));
      } catch {
        throw new BillingWebhookError("invalid", "The webhook body is not JSON.");
      }
      const parsed = FakeWebhookBody.safeParse(json);
      if (!parsed.success) throw new BillingWebhookError("invalid", "The webhook body is not recognized.");
      const { id, type, occurred_at, data } = parsed.data;
      return {
        provider: FAKE_PROVIDER_ID,
        eventId: id,
        type,
        householdId: data.household_id,
        occurredAt: occurred_at,
        subscription: {
          providerCustomerId: data.customer_id,
          providerSubscriptionId: data.subscription_id,
          status: data.status,
          interval: data.interval,
          currentPeriodEnd: data.current_period_end,
          cancelAtPeriodEnd: data.cancel_at_period_end,
        },
      };
    },
  };
}
