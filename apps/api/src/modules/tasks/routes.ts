// Thin routes for household tasks (BACKEND_PLAN §8.2). Recipe: ../../lib/module.ts.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  CreateTask,
  HouseholdParams,
  PatchTask,
  Task,
  TaskGroups,
  TaskListQuery,
  TaskParams,
} from "@mp/contracts";
import { requireIfMatch, setVersionTag } from "../../lib/if-match";
import { actor } from "../items/actor";
import * as service from "./service";
import type { TasksDeps } from "./service";

export function tasksRoutes(deps: () => TasksDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/tasks",
      {
        schema: {
          summary: "Tasks grouped as due this week, later and done, with the nav badge",
          params: HouseholdParams,
          querystring: TaskListQuery,
          response: { 200: TaskGroups },
        },
      },
      async (request) => service.listTasks(deps(), actor(request), request.query.owner),
    );

    scope.post(
      "/households/:hid/tasks",
      {
        schema: { summary: "Add a task", params: HouseholdParams, body: CreateTask, response: { 201: Task } },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        const task = await service.createTask(deps(), actor(request), request.body);
        return setVersionTag(reply, task.version)
          .code(201)
          .header("location", `/v1/households/${task.householdId}/tasks/${task.id}`)
          .send(task);
      },
    );

    scope.get(
      "/households/:hid/tasks/:id",
      { schema: { summary: "One task", params: TaskParams, response: { 200: Task } } },
      async (request, reply) => {
        const task = await service.getTask(deps(), actor(request), request.params.id);
        return setVersionTag(reply, task.version).send(task);
      },
    );

    scope.patch(
      "/households/:hid/tasks/:id",
      {
        schema: {
          summary: "Edit, complete or reopen a task",
          params: TaskParams,
          body: PatchTask,
          response: { 200: Task },
        },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        const expected = requireIfMatch(request);
        const task = await service.patchTask(
          deps(),
          actor(request),
          request.params.id,
          expected,
          request.body,
        );
        return setVersionTag(reply, task.version).send(task);
      },
    );
  };
}
