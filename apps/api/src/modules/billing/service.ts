// Billing logic: plan state, checkout and portal for the billing owner, and the webhook intake.
import {
  entitlementsForPlan,
  BillingWebhookError,
  type BillingProvider,
  type WebhookVerifier,
} from "@mp/billing";
import { AppError, type BillingState, type BillingUrl, type CheckoutBody } from "@mp/contracts";
import type { ApiContext, ApiDb } from "@mp/db";
import * as repo from "./repo";

export interface BillingDeps {
  db: ApiDb;
  /** Null while no provider is configured (H-01). */
  provider: BillingProvider | null;
  verifier: WebhookVerifier;
  now: () => string;
}

export interface Caller {
  ctx: ApiContext;
  userId: string;
  householdId: string;
}

const notFound = () => new AppError("not_found", 404, "Household not found.");
const unavailable = () => new AppError("internal_error", 503, "Billing is not available right now.");

export async function getState(deps: BillingDeps, who: Caller): Promise<BillingState> {
  return deps.db.withHouseholdTx(who.ctx, async (tx) => {
    const plan = await repo.getPlan(tx, who.householdId);
    if (!plan) throw notFound();
    const subscription = await repo.getSubscription(tx, who.householdId);
    return {
      plan,
      status: subscription?.status ?? null,
      interval: subscription?.interval ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      isBillingOwner: await repo.isBillingOwner(tx, who.householdId, who.userId),
      available: deps.provider !== null,
      entitlements: entitlementsForPlan(plan),
    };
  });
}

/** Only the billing owner (the creator, transferable) manages billing. */
async function requireOwner(deps: BillingDeps, who: Caller) {
  return deps.db.withHouseholdTx(who.ctx, async (tx) => {
    const plan = await repo.getPlan(tx, who.householdId);
    if (!plan) throw notFound();
    if (!(await repo.isBillingOwner(tx, who.householdId, who.userId))) {
      throw new AppError("forbidden", 403, "Only the billing owner can manage billing.");
    }
    return {
      plan,
      subscription: await repo.getSubscription(tx, who.householdId),
      email: await repo.getUserEmail(tx, who.userId),
    };
  });
}

export async function createCheckout(
  deps: BillingDeps,
  who: Caller,
  body: CheckoutBody,
): Promise<BillingUrl> {
  const owner = await requireOwner(deps, who);
  if (!deps.provider) throw unavailable();
  const live = owner.subscription && ["trialing", "active", "past_due"].includes(owner.subscription.status);
  if (owner.plan === "family_plus" && live) {
    throw new AppError("conflict", 409, "This household already has Family Plus. Use the billing portal.");
  }
  if (!owner.email) throw new AppError("forbidden", 403, "Your account has no email address.");
  return deps.provider.createCheckout({
    householdId: who.householdId,
    interval: body.interval,
    email: owner.email,
  });
}

export async function portalUrl(deps: BillingDeps, who: Caller): Promise<BillingUrl> {
  const owner = await requireOwner(deps, who);
  if (!deps.provider) throw unavailable();
  if (!owner.subscription) throw new AppError("conflict", 409, "This household has no subscription yet.");
  return deps.provider.portalUrl({
    householdId: who.householdId,
    providerCustomerId: owner.subscription.providerCustomerId,
  });
}

export type WebhookResult = "queued" | "duplicate" | "ignored";

/**
 * Verify first (inside the provider, with the WP-08 helpers), then record in `webhook_events` and queue for
 * the worker. A repeat of an event id is a 200 that changes nothing.
 */
export async function receiveWebhook(
  deps: BillingDeps,
  input: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> },
): Promise<WebhookResult> {
  if (!deps.provider) throw unavailable();
  let event;
  try {
    event = await deps.provider.handleWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      nowMs: Date.parse(deps.now()),
      verifier: deps.verifier,
    });
  } catch (err) {
    if (err instanceof BillingWebhookError) {
      if (err.kind === "invalid")
        throw new AppError("validation_failed", 400, "The webhook body is invalid.");
      if (err.kind === "not_configured") throw unavailable();
      throw new AppError("unauthorized", 401, "The webhook signature is invalid.");
    }
    throw err;
  }
  if (!event) return "ignored";
  const isNew = await deps.db.withHouseholdTx({ userId: null }, (tx) =>
    repo.ingestEvent(tx, {
      provider: event.provider,
      eventId: event.eventId,
      householdId: event.householdId,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: { subscription: event.subscription },
    }),
  );
  return isNew ? "queued" : "duplicate";
}
