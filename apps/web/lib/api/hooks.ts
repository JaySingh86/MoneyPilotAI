"use client";

import type { components } from "@mp/contracts/client";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { ApiError, getJson } from "./client";
import type { CalendarResponse, PlanResponse } from "./planning-types";

export type HouseholdSummary = components["schemas"]["HouseholdSummary"];

export interface ActiveHousehold {
  id: string;
  name: string;
}

/** The household the signed-in user is acting in: their first membership (a user has one in the MVP). */
export function useActiveHousehold(): ActiveHousehold | null {
  const { me } = useAuth();
  const membership = me?.memberships[0];
  return membership ? { id: membership.householdId, name: membership.householdName } : null;
}

const MINUTE = 60_000;

/** `GET /households/:hid/summary`: nav badges, members, entitlements. Refreshed every minute and on focus. */
export function useSummary(): UseQueryResult<HouseholdSummary> {
  const { api } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["summary", household?.id],
    enabled: household !== null,
    refetchInterval: MINUTE,
    queryFn: async () => {
      const { data, error, response } = await api.GET("/v1/households/{hid}/summary", {
        params: { path: { hid: household?.id ?? "" } },
      });
      if (!data) throw new ApiError(response.status, error?.code ?? "internal_error", error?.detail ?? "");
      return data;
    },
  });
}

/** `GET /households/:hid/plan`: the Overview payload. */
export function usePlan(): UseQueryResult<PlanResponse> {
  const { getToken } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["plan", household?.id],
    enabled: household !== null,
    staleTime: MINUTE / 2,
    queryFn: () => getJson<PlanResponse>(`/v1/households/${household?.id}/plan`, getToken),
  });
}

/** `GET /households/:hid/calendar?month=&owner=`. `owner` is a member id, or undefined for everyone. */
export function useCalendar(
  month: string | null,
  owner: string | undefined,
): UseQueryResult<CalendarResponse> {
  const { getToken } = useAuth();
  const household = useActiveHousehold();
  return useQuery({
    queryKey: ["calendar", household?.id, month, owner ?? "all"],
    enabled: household !== null && month !== null,
    staleTime: MINUTE / 2,
    placeholderData: (previous) => previous,
    queryFn: () =>
      getJson<CalendarResponse>(`/v1/households/${household?.id}/calendar`, getToken, {
        month: month ?? undefined,
        owner,
      }),
  });
}
