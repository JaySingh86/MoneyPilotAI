// MSW handlers: the API as the web app sees it, served from the fixture through the engine.
// Shapes follow @mp/contracts where it has them (/me, /households/:hid/summary, /me/bootstrap) and
// lib/api/planning-types.ts where WP-12 has not added them yet (/plan, /calendar).
import { delay, http, HttpResponse } from "msw";
import { API_BASE_URL } from "../lib/config";
import { HOUSEHOLD_ID, ME, summary } from "./identity";
import { listsHandlers } from "./lists-handlers";
import { taskBadge as tasksDueBadge } from "./lists-model";
import { buildCalendar, buildPlan } from "./model";
import { state } from "./state";
import { reviewQueueCount, withWp23Overrides } from "./wp23-data";
import { wp23Handlers } from "./wp23-handlers";
import type { FaultTarget } from "./state";

const API = `${API_BASE_URL}/v1`;

function problem(status: number, code: string, detail: string): Response {
  return HttpResponse.json(
    { type: `/problems/${code}`, title: detail, status, code, detail },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

async function serve(target: FaultTarget, body: () => unknown): Promise<Response> {
  if (state.delayMs > 0) await delay(state.delayMs);
  if (state.faults.has(target)) return problem(500, "internal_error", "The mock API was told to fail.");
  return HttpResponse.json(body() as Record<string, unknown>);
}

export const handlers = [
  ...listsHandlers, // WP-18: items, renewals, goals, tasks
  ...wp23Handlers,
  http.post(`${API}/me/bootstrap`, () => {
    state.bootstrapCalls += 1;
    return HttpResponse.json(ME);
  }),
  http.get(`${API}/me`, () => serve("me", () => ME)),
  http.get(`${API}/households/:hid/summary`, ({ params }) => {
    if (params.hid !== HOUSEHOLD_ID) return problem(404, "not_found", "Household not found.");
    return serve("summary", () =>
      withWp23Overrides(summary(tasksDueBadge(state.scenario), reviewQueueCount(state.scenario), 50000)),
    );
  }),
  http.get(`${API}/households/:hid/plan`, ({ params }) => {
    if (params.hid !== HOUSEHOLD_ID) return problem(404, "not_found", "Household not found.");
    return serve("plan", () => buildPlan(state.scenario));
  }),
  http.get(`${API}/households/:hid/calendar`, ({ params, request }) => {
    if (params.hid !== HOUSEHOLD_ID) return problem(404, "not_found", "Household not found.");
    const url = new URL(request.url);
    const month = url.searchParams.get("month");
    if (!month || !/^\d{4}-\d{2}$/.test(month))
      return problem(400, "validation_failed", "month must be YYYY-MM");
    const owner = url.searchParams.get("owner") ?? undefined;
    return serve("calendar", () => buildCalendar(state.scenario, month, owner));
  }),
];
