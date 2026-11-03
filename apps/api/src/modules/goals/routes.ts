// Thin routes for goals, deposits and goal options (BACKEND_PLAN §8.2). Recipe: ../../lib/module.ts.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateGoal,
  CreateGoalEvent,
  CreateGoalPending,
  Goal,
  GoalEventResult,
  GoalList,
  GoalOptions,
  GoalParams,
  HouseholdParams,
  PatchGoal,
  Proposal,
} from "@mp/contracts";
import { requireIfMatch, setVersionTag } from "../../lib/if-match";
import { actor } from "../items/actor";
import * as service from "./service";
import type { GoalsDeps } from "./service";

export function goalsRoutes(deps: () => GoalsDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/goals",
      {
        schema: {
          summary: "Goals with status, suggestions and the savings KPIs",
          params: HouseholdParams,
          response: { 200: GoalList },
        },
      },
      async (request) => service.listGoals(deps(), actor(request)),
    );

    scope.post(
      "/households/:hid/goals",
      {
        schema: {
          summary: "Add a goal",
          params: HouseholdParams,
          body: CreateGoal,
          response: { 201: Goal, 202: CreateGoalPending },
        },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const created = await service.createGoal(deps(), actor(request), request.body);
        if ("proposal" in created) return reply.code(202).send(created);
        const goal = created.goal;
        return setVersionTag(reply, goal.version)
          .code(201)
          .header("location", `/v1/households/${goal.householdId}/goals/${goal.id}`)
          .send(goal);
      },
    );

    scope.get(
      "/households/:hid/goals/:id",
      { schema: { summary: "One goal", params: GoalParams, response: { 200: Goal } } },
      async (request, reply) => {
        const goal = await service.getGoal(deps(), actor(request), request.params.id);
        return setVersionTag(reply, goal.version).send(goal);
      },
    );

    scope.patch(
      "/households/:hid/goals/:id",
      {
        schema: {
          summary: "Edit a goal; a new monthly amount returns 202 with a proposal for the other member",
          params: GoalParams,
          body: PatchGoal,
          response: { 200: Goal, 202: Proposal },
        },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const expected = requireIfMatch(request);
        const result = await service.patchGoal(
          deps(),
          actor(request),
          request.params.id,
          expected,
          request.body,
        );
        if ("proposal" in result) return reply.code(202).send(result.proposal);
        return setVersionTag(reply, result.applied.version).send(result.applied);
      },
    );

    scope.delete(
      "/households/:hid/goals/:id",
      {
        schema: {
          summary: "Delete a goal; one with a monthly amount returns 202 with a proposal",
          params: GoalParams,
          response: { 204: z.null(), 202: Proposal },
        },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const result = await service.deleteGoal(deps(), actor(request), request.params.id);
        if ("proposal" in result) return reply.code(202).send(result.proposal);
        return reply.code(204).send(null);
      },
    );

    scope.post(
      "/households/:hid/goals/:id/events",
      {
        schema: {
          summary: "Record a deposit or withdrawal (nothing is transferred)",
          params: GoalParams,
          body: CreateGoalEvent,
          response: { 201: GoalEventResult, 202: Proposal },
        },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const result = await service.createGoalEvent(deps(), actor(request), request.params.id, request.body);
        if ("proposal" in result) return reply.code(202).send(result.proposal);
        return setVersionTag(reply, result.goal.version).code(201).send(result);
      },
    );

    scope.get(
      "/households/:hid/goals/:id/options",
      {
        schema: {
          summary: "Ways to stay on track (rule 10)",
          params: GoalParams,
          response: { 200: GoalOptions },
        },
      },
      async (request) => service.goalOptions(deps(), actor(request), request.params.id),
    );
  };
}
