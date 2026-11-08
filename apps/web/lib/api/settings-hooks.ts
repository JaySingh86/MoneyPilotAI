"use client";

// Data hooks for Members & privacy and the setup flow (WP-23).
import type { components } from "@mp/contracts/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { useStepUp } from "../auth/StepUp";
import { ApiError, getJson, newIdempotencyKey, sendJson } from "./client";
import { useActiveHousehold } from "./hooks";
import type {
  ActivityEntry,
  BillingState,
  DeletionRequest,
  ExportRequest,
  Page,
  SharingPreferences,
} from "./imports-types";

type Schemas = components["schemas"];
export type Household = Schemas["Household"];
export type Invite = Schemas["Invite"];
export type Item = Schemas["Item"];

function required<T>(value: T | null): T {
  if (value === null) throw new ApiError(500, "internal_error", "The server sent an empty answer.");
  return value;
}

function useHousehold() {
  const { getToken } = useAuth();
  const household = useActiveHousehold();
  return { getToken, hid: household?.id ?? "", enabled: household !== null };
}

/** Income items, for the primary income select (`GET …/items?direction=inflow`). */
export function useIncomeItems(): UseQueryResult<Item[]> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["income-items", hid],
    enabled,
    queryFn: async () =>
      (await getJson<Page<Item>>(`/v1/households/${hid}/items`, getToken, { direction: "inflow" })).data,
  });
}

export interface HouseholdPatch {
  name?: string;
  cushionCents?: number;
  primaryIncomeItemId?: string;
}

export function usePatchHousehold(): UseMutationResult<Household, Error, HouseholdPatch> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch) =>
      required(await sendJson<Household>("PATCH", `/v1/households/${hid}`, getToken, patch)),
    onSuccess: () => {
      // Cushion and primary income changes recompute the plan (BACKEND_PLAN §8.2).
      void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
      void queryClient.invalidateQueries({ queryKey: ["plan", hid] });
      void queryClient.invalidateQueries({ queryKey: ["calendar", hid] });
    },
  });
}

export function useCreateHousehold(): UseMutationResult<
  Household,
  Error,
  { name: string; cushionCents?: number }
> {
  const { getToken } = useAuth();
  return useMutation({
    mutationFn: async (body) => required(await sendJson<Household>("POST", "/v1/households", getToken, body)),
  });
}

export function useInvite(): UseMutationResult<Invite | null, Error, { email: string; firstName?: string }> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, firstName }) =>
      sendJson<Invite>("POST", `/v1/households/${hid}/invites`, getToken, {
        email,
        ...(firstName ? { firstName } : {}),
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["summary", hid] }),
  });
}

/** "Resend": a new link on the same open invite (Q-179). */
export function useResendInvite(): UseMutationResult<Invite | null, Error, string> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId) =>
      sendJson<Invite>("POST", `/v1/households/${hid}/invites/${inviteId}/resend`, getToken),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["summary", hid] }),
  });
}

export function useLeave(): UseMutationResult<unknown, Error, void> {
  const { getToken, hid } = useHousehold();
  const withStepUp = useStepUp();
  return useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return withStepUp(() =>
        sendJson("POST", `/v1/households/${hid}/leave`, getToken, undefined, undefined, {
          idempotencyKey: key,
        }),
      );
    },
  });
}

export function useSharing(): UseQueryResult<SharingPreferences> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["sharing", hid],
    enabled,
    queryFn: () => getJson<SharingPreferences>(`/v1/households/${hid}/sharing`, getToken),
  });
}

export function useSetSharing(): UseMutationResult<SharingPreferences, Error, SharingPreferences> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (next) =>
      required(await sendJson<SharingPreferences>("PUT", `/v1/households/${hid}/sharing`, getToken, next)),
    onMutate: async (next) => {
      queryClient.setQueryData(["sharing", hid], next);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["sharing", hid] }),
  });
}

export function useActivity(): UseQueryResult<ActivityEntry[]> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["activity", hid],
    enabled,
    queryFn: async () =>
      (await getJson<Page<ActivityEntry>>(`/v1/households/${hid}/activity`, getToken, { limit: "5" })).data,
  });
}

/** WP-25 `GET …/billing`. It carries no price, so the plan row shows the plan and its interval only. */
export function useBilling(): UseQueryResult<BillingState> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["billing", hid],
    enabled,
    queryFn: () => getJson<BillingState>(`/v1/households/${hid}/billing`, getToken),
  });
}

export function useRequestExport(): UseMutationResult<ExportRequest, Error, void> {
  const { getToken, hid } = useHousehold();
  const withStepUp = useStepUp();
  return useMutation({
    mutationFn: async () => {
      const key = newIdempotencyKey();
      return required(
        await withStepUp(() =>
          sendJson<ExportRequest>("POST", `/v1/households/${hid}/exports`, getToken, undefined, undefined, {
            idempotencyKey: key,
          }),
        ),
      );
    },
  });
}

export function useDeletion(): {
  schedule: UseMutationResult<DeletionRequest, Error, void>;
  cancel: UseMutationResult<unknown, Error, void>;
} {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  const withStepUp = useStepUp();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
  const schedule = useMutation({
    mutationFn: async () => {
      const key = newIdempotencyKey();
      return required(
        await withStepUp(() =>
          sendJson<DeletionRequest>(
            "POST",
            `/v1/households/${hid}/deletion`,
            getToken,
            undefined,
            undefined,
            {
              idempotencyKey: key,
            },
          ),
        ),
      );
    },
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => sendJson("DELETE", `/v1/households/${hid}/deletion`, getToken),
    onSuccess: refresh,
  });
  return { schedule, cancel };
}

export interface ManualBill {
  name: string;
  amountCents: number;
  repeats: "monthly" | "every_2_weeks" | "every_6_months" | "yearly";
  /** First due date, `YYYY-MM-DD`: a schedule needs an anchor (Q-176). */
  firstDue: string;
  ownerUserId: string;
}

/** `POST …/items`: a bill typed in by hand during setup. Repeats map to the friendly schedule union. */
export function useCreateBill(): UseMutationResult<Item, Error, ManualBill> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (bill) => {
      const day = Number(bill.firstDue.slice(8, 10));
      const schedule =
        bill.repeats === "monthly"
          ? { type: "monthly_day", day, dtstart: bill.firstDue }
          : bill.repeats === "every_2_weeks"
            ? { type: "every_n_weeks", n: 2, dtstart: bill.firstDue }
            : bill.repeats === "every_6_months"
              ? { type: "every_n_months", n: 6, dtstart: bill.firstDue }
              : { type: "yearly", dtstart: bill.firstDue };
      return required(
        await sendJson<Item>("POST", `/v1/households/${hid}/items`, getToken, {
          direction: "outflow",
          kind: "bill",
          category: "other",
          name: bill.name,
          amountType: "fixed",
          amountCents: bill.amountCents,
          schedule,
          ownerType: "member",
          ownerUserId: bill.ownerUserId,
        }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plan", hid] });
      void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
    },
  });
}

/** "Turn on 2-step verification" for the signed-in member: starts TOTP enrollment, then confirms the first code. */
export function useSetUpTotp() {
  const { adapter } = useAuth();
  const { hid } = useHousehold();
  const queryClient = useQueryClient();
  return {
    start: () => adapter.setUpTotp(),
    /** Call after `confirm(code)` succeeds so the Members card reads the new `mfaEnabled`. */
    done: () => void queryClient.invalidateQueries({ queryKey: ["summary", hid] }),
  };
}
