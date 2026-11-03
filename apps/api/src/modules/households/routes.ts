// /v1/households and /v1/invites routes (BACKEND_PLAN §8.2). Thin: the service owns the logic.
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  AcceptInviteBody,
  AcceptInviteResponse,
  CreateHouseholdBody,
  CreateInviteBody,
  Household,
  HouseholdParams,
  HouseholdSummary,
  Invite,
  InviteParams,
  PatchHouseholdBody,
} from "@mp/contracts";
import { requireStepUp } from "../../auth/authenticator";
import type { RuntimeSource } from "../../auth/runtime";
import { requireIfMatch, setVersionTag } from "../../lib/if-match";
import { requireUser, requireUserId } from "../../plugins/request-context";
import { requestMeta } from "../identity/audit";
import {
  HouseholdService,
  noopLeaveHooks,
  zeroBadges,
  type CallerContext,
  type LeaveHooks,
  type SummaryBadges,
} from "./service";

function caller(request: Parameters<typeof requireUser>[0]): CallerContext {
  const user = requireUser(request);
  return { userId: requireUserId(request), authSubject: user.authSubject };
}

export function householdRoutes(
  source: RuntimeSource,
  hooks: LeaveHooks = noopLeaveHooks,
  badges: SummaryBadges = zeroBadges,
): FastifyPluginAsyncZod {
  const service = () => new HouseholdService(source().db, source().inviteSender, hooks, badges);

  return async (scope) => {
    scope.post(
      "/households",
      {
        schema: { summary: "Create a household", body: CreateHouseholdBody, response: { 201: Household } },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const created = await service().create(caller(request), request.body, requestMeta(request));
        return setVersionTag(reply, created.version)
          .code(201)
          .header("location", `/v1/households/${created.id}`)
          .send(created);
      },
    );

    scope.get(
      "/households/:hid",
      {
        schema: { summary: "Read household settings", params: HouseholdParams, response: { 200: Household } },
      },
      async (request, reply) => {
        const household = await service().get(caller(request), request.params.hid);
        return setVersionTag(reply, household.version).send(household);
      },
    );

    scope.patch(
      "/households/:hid",
      {
        schema: {
          summary: "Update name, time zone or cushion",
          params: HouseholdParams,
          body: PatchHouseholdBody,
          response: { 200: Household },
        },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const who = caller(request);
        const expected = requireIfMatch(request);
        const updated = await service().patch(
          who,
          request.params.hid,
          expected,
          request.body,
          requestMeta(request),
        );
        return setVersionTag(reply, updated.version).send(updated);
      },
    );

    scope.get(
      "/households/:hid/summary",
      {
        schema: {
          summary: "Members, nav badges, entitlements and connection status",
          params: HouseholdParams,
          response: { 200: HouseholdSummary },
        },
      },
      async (request) => service().summary(caller(request), request.params.hid),
    );

    // Invites share the auth-sensitive 20/min budget. The email link carries the only copy of the token,
    // so the response has none (and is safe to store for Idempotency-Key replays).
    scope.post(
      "/households/:hid/invites",
      {
        schema: {
          summary: "Invite a partner by email",
          params: HouseholdParams,
          body: CreateInviteBody,
          response: { 201: Invite },
        },
        config: { idempotency: "required", rateLimitGroup: "authSensitive" },
      },
      async (request, reply) => {
        const invite = await service().createInvite(
          caller(request),
          request.params.hid,
          request.body.email,
          requestMeta(request),
        );
        return reply.code(201).send(invite);
      },
    );

    scope.delete(
      "/households/:hid/invites/:id",
      {
        schema: {
          summary: "Cancel a pending invite",
          params: InviteParams,
          response: { 204: z.null().describe("Cancelled") },
        },
        config: { idempotency: "optional", rateLimitGroup: "authSensitive" },
      },
      async (request, reply) => {
        await service().revokeInvite(
          caller(request),
          request.params.hid,
          request.params.id,
          requestMeta(request),
        );
        return reply.code(204).send(null);
      },
    );

    scope.post(
      "/invites/accept",
      {
        schema: {
          summary: "Accept a partner invite (signed in, email must match)",
          body: AcceptInviteBody,
          response: { 200: AcceptInviteResponse },
        },
        config: { idempotency: "optional", rateLimitGroup: "authSensitive" },
      },
      async (request) => service().acceptInvite(caller(request), request.body.token),
    );

    // Step-up MFA (BACKEND_PLAN §8.2). The check comes first, before anything touches the database.
    scope.post(
      "/households/:hid/leave",
      {
        schema: {
          summary: "Leave the household (step-up MFA)",
          params: HouseholdParams,
          response: { 204: z.null().describe("Left") },
        },
        config: { idempotency: "optional", rateLimitGroup: "authSensitive" },
      },
      async (request, reply) => {
        const who = caller(request);
        requireStepUp(source().provider, request);
        await service().leave(who, request.params.hid, requestMeta(request));
        return reply.code(204).send(null);
      },
    );
  };
}
