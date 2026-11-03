// Thin routes for the plan, what-if, calendar and renewals (BACKEND_PLAN §8.2). Follows the recipe in
// ../../lib/module.ts: params schemas, explicit `config.idempotency` on the one POST, rate limits from the
// platform defaults. All reads; the only row written is the immutable calc snapshot behind `GET /plan`.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import {
  AppError,
  CalendarMonth,
  CalendarQuery,
  HouseholdParams,
  Plan,
  PlanQuery,
  RenewalList,
  RenewalListQuery,
  RenewalsSummary,
  RenewalsSummaryQuery,
  WhatIfRequest,
  WhatIfResponse,
} from "@mp/contracts";
import { dbContext } from "../../plugins/request-context";
import * as service from "./service";
import type { PlanActor, PlanningDeps } from "./service";

/** `If-None-Match` is a list of entity tags, or `*`. Weak tags compare equal for GET. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const tag = t.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

function actor(request: FastifyRequest): PlanActor {
  const householdId = request.ctx.householdId;
  if (!householdId) throw new AppError("validation_failed", 400, "The household id is missing.");
  return { ctx: dbContext(request), householdId };
}

export function planningRoutes(deps: () => PlanningDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/plan",
      {
        schema: {
          summary: "The Overview plan: window, runway, safe to spend, flags, decisions, math",
          params: HouseholdParams,
          querystring: PlanQuery,
          response: { 200: Plan },
        },
        config: { rateLimitGroup: "compute" },
      },
      async (request, reply) => {
        const plan = await service.getPlan(deps(), actor(request), request.query.asOf);
        if (plan.calcSnapshotId === null) return plan; // not today's plan: nothing stored, no tag
        // The snapshot id changes exactly when the plan inputs change, so it is the entity tag.
        const etag = `"${plan.calcSnapshotId}"`;
        reply.header("etag", etag);
        if (matchesEtag(request.headers["if-none-match"], etag))
          // 304 has no body and no schema; the typed reply only knows the declared 200.
          return reply.code(304 as 200).send(undefined as never);
        return plan;
      },
    );

    // A POST that only calculates: nothing is stored, so there is nothing to replay (idempotency off).
    scope.post(
      "/households/:hid/plan/what-if",
      {
        schema: {
          summary: "Recalculate the plan with hypothetical changes (no writes)",
          params: HouseholdParams,
          body: WhatIfRequest,
          response: { 200: WhatIfResponse },
        },
        config: { idempotency: "off", rateLimitGroup: "compute" },
      },
      async (request, reply) =>
        reply
          .code(200)
          .send(await service.planWhatIf(deps(), actor(request), request.body.changes, request.body.asOf)),
    );

    scope.get(
      "/households/:hid/calendar",
      {
        schema: {
          summary: "Month grid model",
          params: HouseholdParams,
          querystring: CalendarQuery,
          response: { 200: CalendarMonth },
        },
        config: { rateLimitGroup: "compute" },
      },
      async (request) => {
        const { month, owner, asOf } = request.query;
        return service.getCalendar(deps(), actor(request), month, owner, asOf);
      },
    );

    scope.get(
      "/households/:hid/renewals",
      {
        schema: {
          summary: "Renewals and subscriptions, sorted by next action",
          params: HouseholdParams,
          querystring: RenewalListQuery,
          response: { 200: RenewalList },
        },
      },
      async (request) =>
        service.listRenewals(deps(), actor(request), request.query.category, request.query.asOf),
    );

    scope.get(
      "/households/:hid/renewals/summary",
      {
        schema: {
          summary: "Renewals KPIs",
          params: HouseholdParams,
          querystring: RenewalsSummaryQuery,
          response: { 200: RenewalsSummary },
        },
      },
      async (request) => service.getRenewalsSummary(deps(), actor(request), request.query.asOf),
    );
  };
}
