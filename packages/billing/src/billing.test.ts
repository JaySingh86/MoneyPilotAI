import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BillingWebhookError,
  DEFAULT_ENTITLEMENT_CONFIG,
  FEATURES,
  canWrite,
  createFakeProvider,
  createProviderFromEnv,
  entitlementsForPlan,
  planFor,
  signFakeWebhook,
  type FakeWebhookBody,
  type SubscriptionSnapshot,
  type WebhookVerifier,
} from "./index";

const HOUSEHOLD = "6f1f3a52-0a42-4d6e-9a77-3a3f3b1a0001";
const NOW = Date.parse("2026-11-04T12:00:00Z");

// A verifier shaped like apps/api/src/lib/webhooks (constant-time HMAC, 5-minute window).
const verifier: WebhookVerifier = {
  hmac: ({ secret, payload, signature }) => {
    const expected = createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
  fresh: (ts, nowMs) => Math.abs(nowMs / 1000 - ts) <= 300,
};

function sub(partial: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    status: "active",
    interval: "month",
    currentPeriodEnd: "2026-12-04T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...partial,
  };
}

describe("entitlements", () => {
  it("Family Plus can write every feature", () => {
    const e = entitlementsForPlan("family_plus");
    for (const feature of FEATURES) expect(e.features[feature]).toEqual({ read: true, write: true });
    expect(e.limits.items).toBeNull();
  });

  it("Free keeps read access everywhere but cannot write a Plus feature (a downgrade is read-only)", () => {
    const e = entitlementsForPlan("free");
    expect(e.features.goals).toEqual({ read: true, write: false });
    expect(canWrite("free", "goals")).toBe(false);
    for (const feature of FEATURES) expect(e.features[feature].read).toBe(true);
  });

  it("the free/Plus split is configuration (BACKEND_PLAN §17 item 5)", () => {
    const config = {
      ...DEFAULT_ENTITLEMENT_CONFIG,
      tiers: { ...DEFAULT_ENTITLEMENT_CONFIG.tiers, partnerSharing: "free" as const },
    };
    expect(canWrite("free", "partnerSharing", config)).toBe(true);
    expect(canWrite("free", "goals", config)).toBe(false);
  });

  it("the spec default puts the §7.10 list on Plus", () => {
    expect(DEFAULT_ENTITLEMENT_CONFIG.tiers).toEqual({
      partnerSharing: "plus",
      goals: "plus",
      reminders: "plus",
      emailConnections: "plus",
      renewalAlerts: "plus",
      unlimitedItems: "plus",
    });
  });

  it("an item cap applies to Free only, and only when one is configured", () => {
    const config = { ...DEFAULT_ENTITLEMENT_CONFIG, freeItemLimit: 10 };
    expect(entitlementsForPlan("free", config).limits.items).toBe(10);
    expect(entitlementsForPlan("family_plus", config).limits.items).toBeNull();
    expect(entitlementsForPlan("free").limits.items).toBeNull();
  });
});

describe("planFor", () => {
  it("maps statuses to plans", () => {
    expect(planFor(null, NOW)).toBe("free");
    expect(planFor(sub({ status: "active" }), NOW)).toBe("family_plus");
    expect(planFor(sub({ status: "trialing" }), NOW)).toBe("family_plus");
    expect(planFor(sub({ status: "past_due" }), NOW)).toBe("family_plus");
    expect(planFor(sub({ status: "expired" }), NOW)).toBe("free");
  });

  it("a canceled subscription keeps Plus until the paid period ends", () => {
    expect(planFor(sub({ status: "canceled", currentPeriodEnd: "2026-11-30T00:00:00.000Z" }), NOW)).toBe(
      "family_plus",
    );
    expect(planFor(sub({ status: "canceled", currentPeriodEnd: "2026-11-01T00:00:00.000Z" }), NOW)).toBe(
      "free",
    );
    expect(planFor(sub({ status: "canceled", currentPeriodEnd: null }), NOW)).toBe("free");
  });
});

describe("fake provider", () => {
  const secret = "test-only-secret";
  const provider = createFakeProvider({ webhookSecret: secret });
  const body: FakeWebhookBody = {
    id: "evt_1",
    type: "subscription.updated",
    occurred_at: "2026-11-04T11:59:00.000Z",
    data: {
      household_id: HOUSEHOLD,
      customer_id: "cus_1",
      subscription_id: "sub_1",
      status: "active",
      interval: "year",
      current_period_end: "2027-11-04T00:00:00.000Z",
      cancel_at_period_end: false,
    },
  };
  const ts = Math.floor(NOW / 1000);

  it("verifies the signature, then returns a normalized event", async () => {
    const { rawBody, headers } = signFakeWebhook(secret, body, ts);
    const event = await provider.handleWebhook({ rawBody, headers, nowMs: NOW, verifier });
    expect(event).toMatchObject({
      provider: "fake",
      eventId: "evt_1",
      householdId: HOUSEHOLD,
      subscription: { status: "active", interval: "year" },
    });
  });

  async function failure(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (err) {
      if (err instanceof BillingWebhookError) return err.kind;
      throw err;
    }
    return "none";
  }

  it("refuses a tampered body, a wrong secret, a stale timestamp and a missing signature", async () => {
    const signed = signFakeWebhook(secret, body, ts);
    const tampered = Buffer.from(signed.rawBody.toString().replace("active", "expired"));
    expect(
      await failure(() => provider.handleWebhook({ ...signed, rawBody: tampered, nowMs: NOW, verifier })),
    ).toBe("signature");
    const other = signFakeWebhook("another-secret", body, ts);
    expect(await failure(() => provider.handleWebhook({ ...other, nowMs: NOW, verifier }))).toBe("signature");
    const old = signFakeWebhook(secret, body, ts - 3600);
    expect(await failure(() => provider.handleWebhook({ ...old, nowMs: NOW, verifier }))).toBe("signature");
    expect(
      await failure(() =>
        provider.handleWebhook({ rawBody: signed.rawBody, headers: {}, nowMs: NOW, verifier }),
      ),
    ).toBe("signature");
  });

  it("rejects a signed but malformed body, and fails closed without a secret", async () => {
    const bad = signFakeWebhook(secret, { ...body, data: { ...body.data, status: "weird" } } as never, ts);
    expect(await failure(() => provider.handleWebhook({ ...bad, nowMs: NOW, verifier }))).toBe("invalid");
    const closed = createFakeProvider({ webhookSecret: undefined });
    const signed = signFakeWebhook(secret, body, ts);
    expect(await failure(() => closed.handleWebhook({ ...signed, nowMs: NOW, verifier }))).toBe(
      "not_configured",
    );
  });

  it("builds checkout and portal URLs on a reserved .invalid host", async () => {
    const checkout = await provider.createCheckout({
      householdId: HOUSEHOLD,
      interval: "month",
      email: "a@b.c",
    });
    expect(new URL(checkout.url).hostname.endsWith(".invalid")).toBe(true);
    expect(checkout.url).toContain(HOUSEHOLD);
    expect(checkout.url).not.toContain("a%40b.c");
    const portal = await provider.portalUrl({ householdId: HOUSEHOLD, providerCustomerId: "cus_1" });
    expect(new URL(portal.url).hostname.endsWith(".invalid")).toBe(true);
  });
});

describe("createProviderFromEnv (L1)", () => {
  it("is null when unset", () => {
    expect(createProviderFromEnv({})).toBeNull();
    expect(createProviderFromEnv({ NODE_ENV: "production" })).toBeNull();
  });

  it("allows the fake only in development and test", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(
        createProviderFromEnv({ NODE_ENV, BILLING_PROVIDER: "fake", BILLING_WEBHOOK_SECRET: "x" })?.id,
      ).toBe("fake");
    }
  });

  it("refuses the fake in production, staging, any other value, and when NODE_ENV is unset", () => {
    for (const NODE_ENV of ["production", "staging", "preview", "", undefined]) {
      expect(() => createProviderFromEnv({ NODE_ENV, BILLING_PROVIDER: "fake" })).toThrow(/not allowed/);
    }
  });

  it("refuses an unknown provider name instead of silently running without billing", () => {
    expect(() => createProviderFromEnv({ NODE_ENV: "development", BILLING_PROVIDER: "stripe" })).toThrow(
      /unknown/i,
    );
  });
});
