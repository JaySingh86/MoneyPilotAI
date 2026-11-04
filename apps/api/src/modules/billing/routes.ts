// Thin routes for billing (BACKEND_PLAN §8.2, §8.4). Recipe: ../../lib/module.ts.
//
// Step-up MFA (ADR-018, Q-152): the customer portal requires it, because it can cancel the plan and change the
// payment method. Checkout does not: it only starts a purchase the owner then confirms with the provider.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, BillingState, BillingUrl, CheckoutBody, HouseholdParams } from "@mp/contracts";
import { requireStepUp } from "../../auth/authenticator";
import type { AuthProvider } from "../../auth/provider";
import { rawBody } from "../../plugins/raw-body";
import { actor } from "../items/actor";
import * as service from "./service";
import type { BillingDeps } from "./service";

export function billingRoutes(deps: () => BillingDeps, auth: () => AuthProvider): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/billing",
      {
        schema: {
          summary: "Plan, subscription state and entitlements",
          params: HouseholdParams,
          response: { 200: BillingState },
        },
      },
      async (request) => service.getState(deps(), actor(request)),
    );

    // The responses carry a one-time provider URL, so they are never stored for replay ("off", §8.1).
    scope.post(
      "/households/:hid/billing/checkout",
      {
        schema: {
          summary: "Start a Family Plus checkout (billing owner)",
          params: HouseholdParams,
          body: CheckoutBody,
          response: { 200: BillingUrl },
        },
        config: { idempotency: "off", rateLimitGroup: "authSensitive" },
      },
      async (request) => service.createCheckout(deps(), actor(request), request.body),
    );

    scope.post(
      "/households/:hid/billing/portal",
      {
        schema: {
          summary: "Open the provider's customer portal (billing owner, step-up MFA)",
          params: HouseholdParams,
          response: { 200: BillingUrl },
        },
        config: { idempotency: "off", rateLimitGroup: "authSensitive" },
      },
      async (request) => {
        // First, before anything touches the database.
        requireStepUp(auth(), request);
        return service.portalUrl(deps(), actor(request));
      },
    );
  };
}

/** `POST /webhooks/billing`: verified with the provider's signature over the raw bytes (BACKEND_PLAN §8.4). */
export function billingWebhookRoutes(deps: () => BillingDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    await scope.register(rawBody);

    scope.post(
      "/billing",
      {
        schema: { response: { 200: z.object({ status: z.enum(["queued", "duplicate", "ignored"]) }) } },
        config: { rateLimit: false, idempotency: "off" },
      },
      async (request) => {
        const body = request.rawBody;
        if (!body) throw new AppError("validation_failed", 400, "The webhook has no body.");
        const status = await service.receiveWebhook(deps(), { rawBody: body, headers: request.headers });
        return { status };
      },
    );
  };
}
