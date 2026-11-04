// Thin routes for CSV import (BACKEND_PLAN §8.2). Recipe: ../../lib/module.ts. All write routes share the
// `imports` rate-limit group (10 per minute per user).
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  ColumnMapping,
  CreateImport,
  CreatedImport,
  HouseholdParams,
  Import,
  ImportParams,
} from "@mp/contracts";
import { actor } from "../items/actor";
import * as service from "./service";
import type { ImportsDeps } from "./service";

export function importsRoutes(deps: () => ImportsDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.post(
      "/households/:hid/imports",
      {
        schema: {
          summary: "Start a CSV import: returns a presigned upload (max 10 MB)",
          params: HouseholdParams,
          body: CreateImport,
          response: { 201: CreatedImport },
        },
        // The response carries a presigned URL, so it is never stored for replay.
        config: { idempotency: "off", rateLimitGroup: "imports" },
      },
      async (request, reply) => {
        const created = await service.createImport(deps(), actor(request), request.body);
        return reply
          .code(201)
          .header("location", `/v1/households/${request.params.hid}/imports/${created.import.id}`)
          .send(created);
      },
    );

    scope.post(
      "/households/:hid/imports/:id/process",
      {
        schema: {
          summary: "Process the uploaded file: parse, dedupe, detect recurring items",
          params: ImportParams,
          response: { 200: Import },
        },
        config: { idempotency: "optional", rateLimitGroup: "imports" },
      },
      async (request) => service.processImport(deps(), actor(request), request.params.id),
    );

    scope.put(
      "/households/:hid/imports/:id/mapping",
      {
        schema: {
          summary: "Say which column is the date, description and amount; the saved mapping is reused",
          params: ImportParams,
          body: ColumnMapping,
          response: { 200: Import },
        },
        config: { idempotency: "optional", rateLimitGroup: "imports" },
      },
      async (request) => service.putMapping(deps(), actor(request), request.params.id, request.body),
    );

    scope.get(
      "/households/:hid/imports/:id",
      { schema: { summary: "Import status and counts", params: ImportParams, response: { 200: Import } } },
      async (request) => service.getImport(deps(), actor(request), request.params.id),
    );
  };
}
