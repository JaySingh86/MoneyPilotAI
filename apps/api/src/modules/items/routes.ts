// Thin routes for items, renewals, occurrences, planned expenses and balances (BACKEND_PLAN §8.2).
// Follows the recipe in ../../lib/module.ts: params schemas, explicit `config.idempotency` on writes,
// If-Match on PATCH, ETag on every versioned response.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AmountHistory,
  AppError,
  Balance,
  CreateBalance,
  CreateItem,
  CreatePlannedExpense,
  HouseholdParams,
  Item,
  ItemListQuery,
  ItemParams,
  MAX_OCCURRENCE_RANGE_DAYS,
  Occurrence,
  OccurrenceList,
  OccurrenceListQuery,
  OccurrenceParams,
  PatchItem,
  PatchOccurrence,
  PatchPlannedExpense,
  PlannedExpense,
  PlannedExpenseList,
  PlannedExpenseListQuery,
  PutRenewalDetails,
  Uuid,
  page,
} from "@mp/contracts";
import { parseDate } from "@mp/engine";
import { requireIfMatch, setVersionTag } from "../../lib/if-match";
import { dbContext, requireUserId } from "../../plugins/request-context";
import * as service from "./service";
import type { Actor, ItemsDeps } from "./service";

const PlannedParams = HouseholdParams.extend({ id: Uuid });

function actor(request: FastifyRequest): Actor {
  const ctx = dbContext(request);
  const householdId = request.ctx.householdId;
  if (!householdId) throw new AppError("validation_failed", 400, "The household id is missing.");
  return { ctx, userId: requireUserId(request), householdId };
}

function checkRange(from: string, to: string): void {
  const days = parseDate(to).since(parseDate(from), { largestUnit: "days" }).days;
  if (days < 0 || days > MAX_OCCURRENCE_RANGE_DAYS) {
    throw new AppError("validation_failed", 400, "The date range is invalid.", {
      fields: [
        {
          in: "querystring",
          path: "to",
          message: `Must be on or after from and within ${MAX_OCCURRENCE_RANGE_DAYS} days`,
        },
      ],
    });
  }
}

export function itemsRoutes(deps: () => ItemsDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    const ItemPage = page(Item);

    scope.get(
      "/households/:hid/items",
      { schema: { params: HouseholdParams, querystring: ItemListQuery, response: { 200: ItemPage } } },
      async (request) => {
        const { limit, cursor, ...filter } = request.query;
        return service.listItems(
          deps(),
          actor(request),
          { ...filter, ...(cursor ? { after: cursor } : {}) },
          limit,
        );
      },
    );

    scope.post(
      "/households/:hid/items",
      {
        schema: { params: HouseholdParams, body: CreateItem, response: { 201: Item } },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const item = await service.createItem(deps(), actor(request), request.body);
        return setVersionTag(reply, item.version)
          .code(201)
          .header("location", `/v1/households/${item.householdId}/items/${item.id}`)
          .send(item);
      },
    );

    scope.get(
      "/households/:hid/items/:id",
      { schema: { params: ItemParams, response: { 200: Item } } },
      async (request, reply) => {
        const item = await service.getItem(deps(), actor(request), request.params.id);
        return setVersionTag(reply, item.version).send(item);
      },
    );

    scope.patch(
      "/households/:hid/items/:id",
      {
        schema: { params: ItemParams, body: PatchItem, response: { 200: Item } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const expected = requireIfMatch(request);
        const item = await service.patchItem(
          deps(),
          actor(request),
          request.params.id,
          expected,
          request.body,
        );
        return setVersionTag(reply, item.version).send(item);
      },
    );

    scope.delete(
      "/households/:hid/items/:id",
      {
        schema: { params: ItemParams, response: { 204: z.null() } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        await service.deleteItem(deps(), actor(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    scope.put(
      "/households/:hid/items/:id/renewal",
      {
        schema: { params: ItemParams, body: PutRenewalDetails, response: { 200: Item } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const item = await service.putRenewal(deps(), actor(request), request.params.id, request.body);
        return setVersionTag(reply, item.version).send(item);
      },
    );

    scope.get(
      "/households/:hid/items/:id/history",
      { schema: { params: ItemParams, response: { 200: AmountHistory } } },
      async (request) => service.itemHistory(deps(), actor(request), request.params.id),
    );

    // ===== Occurrences =====
    scope.get(
      "/households/:hid/occurrences",
      {
        schema: {
          params: HouseholdParams,
          querystring: OccurrenceListQuery,
          response: { 200: OccurrenceList },
        },
      },
      async (request) => {
        const { from, to, itemId } = request.query;
        checkRange(from, to);
        return service.listOccurrences(deps(), actor(request), from, to, itemId);
      },
    );

    scope.patch(
      "/households/:hid/occurrences/:id",
      {
        schema: { params: OccurrenceParams, body: PatchOccurrence, response: { 200: Occurrence } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const expected = requireIfMatch(request);
        const occurrence = await service.patchOccurrence(
          deps(),
          actor(request),
          request.params.id,
          expected,
          request.body,
        );
        return setVersionTag(reply, occurrence.version).send(occurrence);
      },
    );

    // ===== Planned expenses =====
    scope.get(
      "/households/:hid/planned-expenses",
      {
        schema: {
          params: HouseholdParams,
          querystring: PlannedExpenseListQuery,
          response: { 200: PlannedExpenseList },
        },
      },
      async (request) => service.listPlanned(deps(), actor(request), request.query.status),
    );

    scope.post(
      "/households/:hid/planned-expenses",
      {
        schema: { params: HouseholdParams, body: CreatePlannedExpense, response: { 201: PlannedExpense } },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const created = await service.createPlanned(deps(), actor(request), request.body);
        return setVersionTag(reply, created.version)
          .code(201)
          .header("location", `/v1/households/${created.householdId}/planned-expenses/${created.id}`)
          .send(created);
      },
    );

    scope.patch(
      "/households/:hid/planned-expenses/:id",
      {
        schema: { params: PlannedParams, body: PatchPlannedExpense, response: { 200: PlannedExpense } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const expected = requireIfMatch(request);
        const updated = await service.patchPlanned(
          deps(),
          actor(request),
          request.params.id,
          expected,
          request.body,
        );
        return setVersionTag(reply, updated.version).send(updated);
      },
    );

    scope.delete(
      "/households/:hid/planned-expenses/:id",
      {
        schema: { params: PlannedParams, response: { 204: z.null() } },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        await service.deletePlanned(deps(), actor(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    // ===== Balances =====
    scope.post(
      "/households/:hid/balances",
      {
        schema: { params: HouseholdParams, body: CreateBalance, response: { 201: Balance } },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const balance = await service.createBalance(deps(), actor(request), request.body);
        return reply.code(201).send(balance);
      },
    );

    scope.get(
      "/households/:hid/balances/latest",
      { schema: { params: HouseholdParams, response: { 200: Balance } } },
      async (request) => service.latestBalance(deps(), actor(request)),
    );
  };
}
