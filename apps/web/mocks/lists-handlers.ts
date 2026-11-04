// MSW handlers for Bills, Renewals, Goals and Tasks: the WP-06, WP-12 and WP-13 endpoints, shaped as
// their contracts. Registered with one line in handlers.ts.
import { delay, http, HttpResponse } from "msw";
import { API_BASE_URL } from "../lib/config";
import { HOUSEHOLD_ID } from "./identity";
import {
  buildGoalOptions,
  buildGoalPreview,
  buildGoals,
  buildHistory,
  buildItems,
  buildOccurrences,
  buildPlannedExpenses,
  buildRenewals,
  buildRenewalsSummary,
  buildTasks,
  createGoal,
  createTask,
  listProposals,
  patchGoal,
  patchOccurrence,
  patchTask,
} from "./lists-model";
import { state } from "./state";
import type { FaultTarget } from "./state";

const H = `${API_BASE_URL}/v1/households/:hid`;

function problem(status: number, code: string, detail: string): Response {
  return HttpResponse.json(
    { type: `/problems/${code}`, title: detail, status, code, detail },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

type Params = { hid?: string | readonly string[] };

async function serve(
  params: Params,
  target: FaultTarget,
  body: () => object | null,
  status = 200,
): Promise<Response> {
  if (params.hid !== HOUSEHOLD_ID) return problem(404, "not_found", "Household not found.");
  if (state.delayMs > 0) await delay(state.delayMs);
  if (state.faults.has(target)) return problem(500, "internal_error", "The mock API was told to fail.");
  const result = body();
  if (result === null) return problem(404, "not_found", "Not found.");
  return HttpResponse.json(result as Record<string, unknown>, { status });
}

const version = (request: Request): number =>
  Number((request.headers.get("if-match") ?? "").replace(/\D/g, ""));

export const listsHandlers = [
  http.get(`${H}/items`, ({ params }) => serve(params, "items", () => buildItems(state.scenario))),
  http.get(`${H}/items/:id/history`, ({ params }) =>
    serve(params, "items", () => buildHistory(state.scenario, String(params.id))),
  ),
  http.get(`${H}/occurrences`, ({ params, request }) => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return problem(400, "validation_failed", "from and to are required");
    return serve(params, "items", () => buildOccurrences(state.scenario, from, to));
  }),
  http.patch(`${H}/occurrences/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { status?: "paid" | "received" | "scheduled" };
    return serve(params, "items", () => patchOccurrence(String(params.id), body.status ?? "paid"));
  }),
  http.get(`${H}/planned-expenses`, ({ params }) =>
    serve(params, "goals", () => buildPlannedExpenses(state.scenario)),
  ),
  http.get(`${H}/renewals/summary`, ({ params }) =>
    serve(params, "renewals", () => ({ ...buildRenewalsSummary(state.scenario) })),
  ),
  http.get(`${H}/renewals`, ({ params, request }) =>
    serve(params, "renewals", () =>
      buildRenewals(state.scenario, new URL(request.url).searchParams.get("category") ?? undefined),
    ),
  ),
  http.get(`${H}/goals/:id/options`, ({ params }) =>
    serve(params, "goals", () => buildGoalOptions(state.scenario, String(params.id))),
  ),
  // Not in the contracts yet (Q-160): the engine's goal status at a monthly amount not saved yet.
  http.get(`${H}/goals/:id/preview`, ({ params, request }) => {
    const monthly = Number(new URL(request.url).searchParams.get("monthlyCents"));
    if (!Number.isSafeInteger(monthly) || monthly < 0)
      return problem(400, "validation_failed", "monthlyCents must be a whole number of cents");
    return serve(params, "goals", () => buildGoalPreview(state.scenario, String(params.id), monthly));
  }),
  http.get(`${H}/goals`, ({ params }) => serve(params, "goals", () => buildGoals(state.scenario))),
  http.post(`${H}/goals`, async ({ params, request }) => {
    const body = (await request.json()) as Parameters<typeof createGoal>[1];
    const result = createGoal(state.scenario, body);
    if (result.status === 202)
      return serve(params, "goals", () => ({ goal: result.goal, proposal: result.proposal }), 202);
    return serve(params, "goals", () => ({ ...result.goal }), 201);
  }),
  http.patch(`${H}/goals/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { monthlyCents?: number };
    const result = patchGoal(state.scenario, String(params.id), version(request), body);
    if (result.status === 404) return problem(404, "not_found", "Goal not found.");
    if (result.status === 409) return problem(409, "conflict", "Someone changed this goal.");
    if (result.status === 202) return serve(params, "goals", () => ({ ...result.proposal }), 202);
    return serve(params, "goals", () => ({ ...result.goal }));
  }),
  http.get(`${H}/proposals`, ({ params, request }) =>
    serve(params, "goals", () => listProposals(new URL(request.url).searchParams.get("status") ?? undefined)),
  ),
  http.get(`${H}/tasks`, ({ params, request }) =>
    serve(params, "tasks", () =>
      buildTasks(state.scenario, new URL(request.url).searchParams.get("owner") ?? undefined),
    ),
  ),
  http.post(`${H}/tasks`, async ({ params, request }) => {
    const body = (await request.json()) as Parameters<typeof createTask>[0];
    return serve(params, "tasks", () => ({ ...createTask(body) }), 201);
  }),
  http.patch(`${H}/tasks/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { completed?: boolean };
    const result = patchTask(String(params.id), version(request), body);
    if (result === "conflict") return problem(409, "conflict", "Someone changed this task.");
    return serve(params, "tasks", () => (result === null ? null : { ...result }));
  }),
];
