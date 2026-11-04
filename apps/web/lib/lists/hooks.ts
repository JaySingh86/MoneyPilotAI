"use client";

// Data hooks for Bills, Renewals, Goals and Tasks (WP-18): the generated client for everything the
// contracts describe, `getJson` for the one read they do not (the goal preview, Q-160).
import type { components } from "@mp/contracts/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { ApiError, getJson } from "../api/client";
import { useActiveHousehold, usePlan } from "../api/hooks";

type Schemas = components["schemas"];
export type Item = Schemas["Item"];
export type BillsAverages = Schemas["BillsAverages"];
export type RenewalRow = Schemas["RenewalRow"];
export type RenewalsSummary = Schemas["RenewalsSummary"];
export type Goal = Schemas["Goal"];
export type GoalList = Schemas["GoalList"];
export type GoalOptions = Schemas["GoalOptions"];
export type Proposal = Schemas["Proposal"];
export type Task = Schemas["Task"];
export type TaskGroups = Schemas["TaskGroups"];
export type PlannedExpense = Schemas["PlannedExpense"];
export type AmountHistoryEntry = Schemas["AmountHistory"]["data"][number];
export type Occurrence = Schemas["Occurrence"];

const MINUTE = 60_000;

interface Result<T> {
  data?: T;
  error?: { code?: string; detail?: string };
  response: Response;
}

function unwrap<T>(result: Result<T>): T {
  if (result.data === undefined)
    throw new ApiError(
      result.response.status,
      result.error?.code ?? "internal_error",
      result.error?.detail ?? "Something went wrong.",
    );
  return result.data;
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Household-local today: the plan's `asOf`. Null until the plan has loaded. */
export function useToday(): string | null {
  return usePlan().data?.asOf ?? null;
}

// ---- Bills & recurring ----

export interface ItemsPage {
  items: Item[];
  averages: BillsAverages | null;
}

/** `GET /items?onBillsPage=true&include=averages`: the Bills & recurring rows and rule 17's averages. */
export function useBillsItems(): UseQueryResult<ItemsPage> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["items", household?.id, "bills"],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: async () => {
      const page = unwrap(
        await api.GET("/v1/households/{hid}/items", {
          params: {
            path: { hid: household?.id ?? "" },
            query: { onBillsPage: "true", include: "averages", limit: 100 },
          },
        }),
      );
      return { items: page.data, averages: page.averages ?? null };
    },
  });
}

/** `GET /items/:id/history`: amounts of past bills, oldest first. */
export function useItemHistory(itemId: string | null): UseQueryResult<AmountHistoryEntry[]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["item-history", household?.id, itemId],
    enabled: household !== null && itemId !== null,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/items/{id}/history", {
          params: { path: { hid: household?.id ?? "", id: itemId ?? "" } },
        }),
      ).data,
  });
}

/** `GET /occurrences?from=&to=`: used for each row's next date. */
export function useOccurrences(from: string | null, to: string | null): UseQueryResult<Occurrence[]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["occurrences", household?.id, from, to],
    enabled: household !== null && from !== null && to !== null,
    staleTime: MINUTE / 2,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/occurrences", {
          params: { path: { hid: household?.id ?? "" }, query: { from: from ?? "", to: to ?? "" } },
        }),
      ).data,
  });
}

/**
 * Marks an occurrence paid (outflows) or received (inflows), or puts it back to scheduled: `PATCH
 * /occurrences/:id`. MoneyPilot never moves money; this only records that the household did.
 */
export function useMarkOccurrence(): UseMutationResult<
  Occurrence,
  ApiError,
  { occurrence: Pick<Occurrence, "id" | "version">; status: "paid" | "received" | "scheduled" }
> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ occurrence, status }) =>
      unwrap(
        await api.PATCH("/v1/households/{hid}/occurrences/{id}", {
          params: { path: { hid: household?.id ?? "", id: occurrence.id } },
          body: { status },
          headers: { "if-match": String(occurrence.version) },
        }),
      ) as Occurrence,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["plan"] });
      void queryClient.invalidateQueries({ queryKey: ["calendar"] });
    },
  });
}

// ---- Renewals ----

export function useRenewals(): UseQueryResult<RenewalRow[]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["renewals", household?.id],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/renewals", { params: { path: { hid: household?.id ?? "" } } }),
      ).data,
  });
}

export function useRenewalsSummary(): UseQueryResult<RenewalsSummary> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["renewals-summary", household?.id],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/renewals/summary", {
          params: { path: { hid: household?.id ?? "" } },
        }),
      ),
  });
}

// ---- Goals ----

export function useGoals(): UseQueryResult<GoalList> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["goals", household?.id],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: async () =>
      unwrap(await api.GET("/v1/households/{hid}/goals", { params: { path: { hid: household?.id ?? "" } } })),
  });
}

export function usePlannedExpenses(): UseQueryResult<PlannedExpense[]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["planned-expenses", household?.id],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/planned-expenses", {
          params: { path: { hid: household?.id ?? "" }, query: { status: "planned" } },
        }),
      ).data,
  });
}

export function useGoalOptions(goalId: string | null): UseQueryResult<GoalOptions> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["goal-options", household?.id, goalId],
    enabled: household !== null && goalId !== null,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/goals/{id}/options", {
          params: { path: { hid: household?.id ?? "", id: goalId ?? "" } },
        }),
      ),
  });
}

/**
 * The engine's answer for a goal at a monthly amount that is not saved yet (Q-160: the contracts have
 * no such endpoint, so this is a request for one; the mock serves it from the engine).
 */
export interface GoalPreview {
  goalId: string;
  monthlyCents: number;
  progress: Goal["progress"];
  /** Rule 16 as "THE MATH" rows. */
  math: Array<{ label: string; cents: number | null; kind: "value" | "total" }>;
  /** "On track", "−$250", "Oct 2027". */
  result: { text: string; onTrack: boolean };
  /** "Saving each month" with this goal at the draft amount. */
  savingEachMonthCents: number;
}

export function useGoalPreview(
  goalId: string | null,
  monthlyCents: number | null,
): UseQueryResult<GoalPreview> {
  const { getToken } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["goal-preview", household?.id, goalId, monthlyCents],
    enabled: household !== null && goalId !== null && monthlyCents !== null,
    placeholderData: (previous) => previous,
    queryFn: () =>
      getJson<GoalPreview>(`/v1/households/${household?.id}/goals/${goalId}/preview`, getToken, {
        monthlyCents: String(monthlyCents),
      }),
  });
}

export function useProposals(): UseQueryResult<Proposal[]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["proposals", household?.id],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/proposals", {
          params: { path: { hid: household?.id ?? "" }, query: { status: "pending" } },
        }),
      ).data,
  });
}

export type GoalChangeResult = { kind: "applied"; goal: Goal } | { kind: "pending"; proposal: Proposal };

/**
 * `PATCH /goals/:id` with `If-Match`. 200 applies at once; 202 returns the proposal the other member
 * approves ("waiting for Jordan"), and nothing changes until then.
 */
export function usePatchGoal(): UseMutationResult<
  GoalChangeResult,
  ApiError,
  { goal: Goal; body: Schemas["PatchGoalInput"] }
> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ goal, body }) => {
      const hid = household?.id ?? "";
      const result = await api.PATCH("/v1/households/{hid}/goals/{id}", {
        params: { path: { hid, id: goal.id } },
        body,
        headers: { "if-match": String(goal.version) },
      });
      if (result.response.status === 202 && result.data) {
        return { kind: "pending", proposal: result.data as Proposal };
      }
      return { kind: "applied", goal: unwrap(result) as Goal };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["goals"] });
      void queryClient.invalidateQueries({ queryKey: ["proposals"] });
      void queryClient.invalidateQueries({ queryKey: ["plan"] });
    },
  });
}

/** `POST /goals`; with a monthly amount and a partner to approve it, 202 creates the goal at $0 plus a proposal. */
export function useCreateGoal(): UseMutationResult<GoalChangeResult, ApiError, Schemas["CreateGoalInput"]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const result = await api.POST("/v1/households/{hid}/goals", {
        params: { path: { hid: household?.id ?? "" } },
        body,
        headers: { "idempotency-key": newKey() },
      });
      if (result.response.status === 202 && result.data) {
        const pending = result.data as Schemas["CreateGoalPending"];
        return { kind: "pending", proposal: pending.proposal };
      }
      return { kind: "applied", goal: unwrap(result) as Goal };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["goals"] });
      void queryClient.invalidateQueries({ queryKey: ["proposals"] });
      void queryClient.invalidateQueries({ queryKey: ["plan"] });
    },
  });
}

// ---- Tasks ----

export function useTasks(owner?: string): UseQueryResult<TaskGroups> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["tasks", household?.id, owner ?? "all"],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    placeholderData: (previous) => previous,
    queryFn: async () =>
      unwrap(
        await api.GET("/v1/households/{hid}/tasks", {
          params: { path: { hid: household?.id ?? "" }, query: owner ? { owner } : {} },
        }),
      ),
  });
}

function useRefreshTasks(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["summary"] });
    void queryClient.invalidateQueries({ queryKey: ["plan"] });
  };
}

/** Completes or reopens a task: `PATCH /tasks/:id` with `If-Match`. Saved by the API, not just the view. */
export function useCompleteTask(): UseMutationResult<Task, ApiError, { task: Task; completed: boolean }> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  const refresh = useRefreshTasks();
  return useMutation({
    mutationFn: async ({ task, completed }) =>
      unwrap(
        await api.PATCH("/v1/households/{hid}/tasks/{id}", {
          params: { path: { hid: household?.id ?? "", id: task.id } },
          body: { completed },
          headers: { "if-match": String(task.version) },
        }),
      ),
    onSuccess: refresh,
  });
}

export function useCreateTask(): UseMutationResult<Task, ApiError, Schemas["CreateTaskInput"]> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  const refresh = useRefreshTasks();
  return useMutation({
    mutationFn: async (body) =>
      unwrap(
        await api.POST("/v1/households/{hid}/tasks", {
          params: { path: { hid: household?.id ?? "" } },
          body,
          headers: { "idempotency-key": newKey() },
        }),
      ),
    onSuccess: refresh,
  });
}
