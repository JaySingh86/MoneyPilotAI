// Thin routes for the review queue and applied changes (BACKEND_PLAN §8.2). Decisions are POST actions on the
// item (no If-Match): the state machine itself rejects a second decision with 409.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import {
  AppError,
  AppliedChange,
  AppliedChangeListQuery,
  AppliedChangePage,
  AppliedChangeParams,
  AutomationStats,
  EditReviewItem,
  HouseholdParams,
  PutSenderRule,
  ReviewDecision,
  ReviewItem,
  ReviewItemPage,
  ReviewItemParams,
  ReviewListQuery,
  SenderRule,
  SenderRuleList,
} from "@mp/contracts";
import { dbContext, requireUserId } from "../../plugins/request-context";
import * as service from "./service";
import type { Actor, ReviewDeps } from "./service";

function actor(request: FastifyRequest): Actor {
  const ctx = dbContext(request);
  const householdId = request.ctx.householdId;
  if (!householdId) throw new AppError("validation_failed", 400, "The household id is missing.");
  return { ctx, userId: requireUserId(request), householdId };
}

export function reviewRoutes(deps: () => ReviewDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/review-items",
      {
        schema: {
          summary: "Review queue (email and CSV extractions)",
          params: HouseholdParams,
          querystring: ReviewListQuery,
          response: { 200: ReviewItemPage },
        },
      },
      async (request) => {
        const { state, limit, cursor } = request.query;
        return service.listReview(deps(), actor(request), state, limit, cursor);
      },
    );

    scope.get(
      "/households/:hid/automation-stats",
      {
        schema: {
          summary: "Share of active items found automatically (email or CSV) rather than typed",
          params: HouseholdParams,
          response: { 200: AutomationStats },
        },
      },
      async (request) => service.automationStats(deps(), actor(request)),
    );

    scope.get(
      "/households/:hid/review-items/:id",
      {
        schema: { summary: "One review item", params: ReviewItemParams, response: { 200: ReviewItem } },
      },
      async (request) => service.getReview(deps(), actor(request), request.params.id),
    );

    scope.post(
      "/households/:hid/review-items/:id/confirm",
      {
        schema: {
          summary: "Confirm: apply the extracted change",
          params: ReviewItemParams,
          response: { 200: ReviewDecision },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.confirm(deps(), actor(request), request.params.id),
    );

    scope.post(
      "/households/:hid/review-items/:id/edit",
      {
        schema: {
          summary: "Edit the extracted fields, then apply",
          params: ReviewItemParams,
          body: EditReviewItem,
          response: { 200: ReviewDecision },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.edit(deps(), actor(request), request.params.id, request.body),
    );

    scope.post(
      "/households/:hid/review-items/:id/ignore",
      {
        schema: {
          summary: "Ignore: nothing changes",
          params: ReviewItemParams,
          response: { 200: ReviewDecision },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.ignore(deps(), actor(request), request.params.id),
    );

    scope.get(
      "/households/:hid/applied-changes",
      {
        schema: {
          summary: "Applied automatically and confirmed changes, newest first",
          params: HouseholdParams,
          querystring: AppliedChangeListQuery,
          response: { 200: AppliedChangePage },
        },
      },
      async (request) =>
        service.listApplied(deps(), actor(request), request.query.limit, request.query.cursor),
    );

    scope.post(
      "/households/:hid/applied-changes/:id/undo",
      {
        schema: {
          summary: "Undo a change within its 30-day window",
          params: AppliedChangeParams,
          response: { 200: AppliedChange },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.undo(deps(), actor(request), request.params.id),
    );

    // Household watch/ignore rules. The global seed list is read-only and not part of this resource.
    scope.get(
      "/households/:hid/sender-rules",
      {
        schema: {
          summary: "The household's watch and ignore sender rules",
          params: HouseholdParams,
          response: { 200: SenderRuleList },
        },
      },
      async (request) => service.listSenderRules(deps(), actor(request)),
    );

    scope.post(
      "/households/:hid/sender-rules",
      {
        schema: {
          summary: "Watch or ignore a sender domain (changes the rule when the domain already has one)",
          params: HouseholdParams,
          body: PutSenderRule,
          response: { 200: SenderRule, 201: SenderRule },
        },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const { rule, created } = await service.putSenderRule(deps(), actor(request), request.body);
        return reply.code(created ? 201 : 200).send(rule);
      },
    );
  };
}
