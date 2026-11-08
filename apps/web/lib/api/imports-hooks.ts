"use client";

// Data hooks for Email & imports and the setup flow (WP-23).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import { useAuth } from "../auth/AuthProvider";
import { useStepUp } from "../auth/StepUp";
import { MOCK_MODE } from "../config";
import { uploadUrl } from "../safe-urls";
import { ApiError, authorized, getJson, newIdempotencyKey, sendJson } from "./client";
import { useActiveHousehold, usePlan, useSummary } from "./hooks";
import type {
  AppliedChange,
  AutomationStats,
  ColumnMapping,
  CreatedImport,
  CsvImportSummary,
  EditFields,
  EmailConnection,
  ForwardingInfo,
  Import,
  ImportUpload,
  Page,
  ReviewDecision,
  ReviewItem,
  SenderRule,
  StartConnectionResponse,
} from "./imports-types";

function required<T>(value: T | null): T {
  if (value === null) throw new ApiError(500, "internal_error", "The server sent an empty answer.");
  return value;
}

/** Household-local today, for date formats: the plan's `asOf`, else the clock in the household's zone. */
export function useToday(): string {
  const plan = usePlan();
  const summary = useSummary();
  if (plan.data?.asOf) return plan.data.asOf;
  const zone = summary.data?.household.timezone ?? "America/New_York";
  return Temporal.Now.plainDateISO(zone).toString();
}

/** The household's IANA time zone, for turning UTC timestamps into local dates. */
export function useSummaryTimeZone(): string {
  return useSummary().data?.household.timezone ?? "America/New_York";
}

function useHousehold() {
  const { getToken } = useAuth();
  const household = useActiveHousehold();
  return { getToken, hid: household?.id ?? "", enabled: household !== null };
}

export function useReviewItems(): UseQueryResult<ReviewItem[]> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["review-items", hid],
    enabled,
    queryFn: async () =>
      (await getJson<Page<ReviewItem>>(`/v1/households/${hid}/review-items`, getToken, { state: "queued" }))
        .data,
  });
}

/** Names of the household's items by id, to title an `update` card from the item it matches (Q-171). */
export function useItemNames(): UseQueryResult<ReadonlyMap<string, string>> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["item-names", hid],
    enabled,
    queryFn: async () => {
      const page = await getJson<Page<{ id: string; name: string }>>(
        `/v1/households/${hid}/items`,
        getToken,
        {
          limit: "100",
        },
      );
      return new Map(page.data.map((item) => [item.id, item.name] as const));
    },
  });
}

export function useAppliedChanges(): UseQueryResult<AppliedChange[]> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["applied-changes", hid],
    enabled,
    queryFn: async () =>
      (await getJson<Page<AppliedChange>>(`/v1/households/${hid}/applied-changes`, getToken)).data,
  });
}

export interface DecideInput {
  id: string;
  kind: "confirm" | "edit" | "ignore";
  fields?: EditFields;
}

export function useDecide(): UseMutationResult<ReviewDecision, Error, DecideInput> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, kind, fields }: DecideInput) =>
      required(
        await sendJson<ReviewDecision>(
          "POST",
          `/v1/households/${hid}/review-items/${id}/${kind}`,
          getToken,
          kind === "edit" ? { fields } : undefined,
        ),
      ),
    onSuccess: () => {
      // The queue, the nav badge and every number the engine derives may have changed.
      void queryClient.invalidateQueries({ queryKey: ["review-items", hid] });
      void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
      void queryClient.invalidateQueries({ queryKey: ["plan", hid] });
    },
  });
}

export function useUndo(): UseMutationResult<AppliedChange, Error, string> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      required(
        await sendJson<AppliedChange>("POST", `/v1/households/${hid}/applied-changes/${id}/undo`, getToken),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["applied-changes", hid] });
      void queryClient.invalidateQueries({ queryKey: ["plan", hid] });
    },
  });
}

export function useSenderRules(enabled: boolean): UseQueryResult<SenderRule[]> {
  const { getToken, hid, enabled: ready } = useHousehold();
  return useQuery({
    queryKey: ["sender-rules", hid],
    enabled: ready && enabled,
    queryFn: async () =>
      (await getJson<{ data: SenderRule[] }>(`/v1/households/${hid}/sender-rules`, getToken)).data,
  });
}

export function useSetSenderRule(): UseMutationResult<
  SenderRule,
  Error,
  { domain: string; rule: SenderRule["rule"] }
> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      required(await sendJson<SenderRule>("POST", `/v1/households/${hid}/sender-rules`, getToken, body)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sender-rules", hid] }),
  });
}

export function useConnections(): UseQueryResult<EmailConnection[]> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["email-connections", hid],
    enabled,
    queryFn: async () =>
      (await getJson<{ data: EmailConnection[] }>(`/v1/households/${hid}/email-connections`, getToken)).data,
  });
}

/** `POST /email-connections/:provider/start` → `{ authUrl }`; the caller sends the browser there. */
export function useStartConnection(): UseMutationResult<
  StartConnectionResponse,
  Error,
  { provider: "gmail" | "outlook"; returnTo: "/imports" | "/setup" }
> {
  const { getToken } = useHousehold();
  const withStepUp = useStepUp();
  return useMutation({
    mutationFn: async ({ provider, returnTo }) => {
      const key = newIdempotencyKey();
      return required(
        await withStepUp(() =>
          sendJson<StartConnectionResponse>(
            "POST",
            `/v1/email-connections/${provider}/start`,
            getToken,
            { returnTo },
            undefined,
            { idempotencyKey: key },
          ),
        ),
      );
    },
  });
}

export function useConnectionAction(): UseMutationResult<
  unknown,
  Error,
  { id: string; action: "pause" | "resume" | "disconnect" }
> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }) =>
      action === "disconnect"
        ? sendJson("DELETE", `/v1/email-connections/${id}`, getToken)
        : sendJson("POST", `/v1/email-connections/${id}/${action}`, getToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["email-connections", hid] });
      void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
    },
  });
}

export function useForwarding(): UseQueryResult<ForwardingInfo> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["forwarding", hid],
    enabled,
    queryFn: () => getJson<ForwardingInfo>(`/v1/households/${hid}/forwarding-address`, getToken),
  });
}

export function useRotateForwarding(): UseMutationResult<ForwardingInfo, Error, void> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      required(
        await sendJson<ForwardingInfo>("POST", `/v1/households/${hid}/forwarding-address/rotate`, getToken),
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["forwarding", hid] }),
  });
}

export function useAutomationStats(): UseQueryResult<AutomationStats> {
  const { getToken, hid, enabled } = useHousehold();
  return useQuery({
    queryKey: ["automation-stats", hid],
    enabled,
    queryFn: () => getJson<AutomationStats>(`/v1/households/${hid}/automation-stats`, getToken),
  });
}

export function useRemindMember(): UseMutationResult<
  unknown,
  Error,
  { userId: string; about: "connect_email" | "two_step" }
> {
  const { getToken, hid } = useHousehold();
  return useMutation({
    mutationFn: ({ userId, about }) =>
      sendJson("POST", `/v1/households/${hid}/members/${userId}/reminders`, getToken, { about }),
  });
}

/**
 * The import the person just made. There is no "latest import" endpoint (Q-174), so the Bank CSV row shows the
 * one kept in client state by {@link useCsvUpload}; after a reload it reads "No file imported yet".
 */
export function useLatestCsv(): UseQueryResult<CsvImportSummary | null> {
  const { hid } = useHousehold();
  return useQuery<CsvImportSummary | null>({
    queryKey: ["latest-csv", hid],
    queryFn: () => null,
    enabled: false,
    // The sample household's golden import (canvas: "checking-oct.csv · Oct 26"); a real session starts empty.
    initialData: MOCK_MODE
      ? { id: "mock-import", filename: "checking-oct.csv", importedAt: "2026-10-26T20:15:00Z" }
      : null,
  });
}

/** How often to ask whether the worker has finished with a file, and how many times. Tests shorten the wait. */
export const csvPoll = { intervalMs: 1000, attempts: 60 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends the file the way the API said to: a form POST with its fields first, or a PUT of the bytes. */
async function sendFile(
  upload: ImportUpload,
  file: File,
  getToken: () => Promise<string | null>,
): Promise<void> {
  const headers = new Headers(upload.headers);
  let request: Request;
  if (upload.method === "POST") {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append("file", file);
    request = new Request(uploadUrl(upload.url), { method: "POST", body: form, headers });
  } else {
    if (!headers.has("content-type")) headers.set("content-type", "text/csv");
    request = new Request(uploadUrl(upload.url), { method: "PUT", body: file, headers });
  }
  // The presigned URL is the storage host: `authorized` adds our bearer token only to our own origin.
  const response = await authorized(request, getToken);
  if (!response.ok) throw new ApiError(response.status, "upload_failed", "The file did not upload.");
}

/** The worker parses the file after `process`: ask until it has either finished, failed or needs a mapping. */
async function settle(start: Import, hid: string, getToken: () => Promise<string | null>): Promise<Import> {
  let current = start;
  for (
    let n = 0;
    n < csvPoll.attempts && (current.status === "uploaded" || current.status === "processing");
    n++
  ) {
    await sleep(csvPoll.intervalMs);
    current = await getJson<Import>(`/v1/households/${hid}/imports/${start.id}`, getToken);
  }
  return current;
}

/**
 * CSV upload flow (BACKEND_PLAN §8.2, WP-16): create the import and get the presigned request, send the file,
 * ask the server to process it, then wait for the result. Detections arrive as review items with `source = csv`.
 */
export function useCsvUpload(): UseMutationResult<Import, Error, File> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const created = required(
        await sendJson<CreatedImport>("POST", `/v1/households/${hid}/imports`, getToken, {
          filename: file.name,
          sizeBytes: file.size,
          contentType: "text/csv",
        }),
      );
      await sendFile(created.upload, file, getToken);
      const queued = required(
        await sendJson<Import>(
          "POST",
          `/v1/households/${hid}/imports/${created.import.id}/process`,
          getToken,
        ),
      );
      const settled = await settle(queued, hid, getToken);
      queryClient.setQueryData<CsvImportSummary>(["latest-csv", hid], {
        id: settled.id,
        filename: settled.filename,
        importedAt: settled.createdAt,
      });
      return settled;
    },
    onSuccess: () => void invalidateAfterImport(queryClient, hid),
  });
}

function invalidateAfterImport(queryClient: ReturnType<typeof useQueryClient>, hid: string) {
  void queryClient.invalidateQueries({ queryKey: ["review-items", hid] });
  void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
  void queryClient.invalidateQueries({ queryKey: ["automation-stats", hid] });
}

/** `PUT …/imports/:id/mapping` for a file whose columns we could not guess, then wait for the result. */
export function useSaveMapping(): UseMutationResult<
  Import,
  Error,
  { importId: string; mapping: ColumnMapping }
> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ importId, mapping }) => {
      const queued = required(
        await sendJson<Import>("PUT", `/v1/households/${hid}/imports/${importId}/mapping`, getToken, mapping),
      );
      return settle(queued, hid, getToken);
    },
    onSuccess: () => void invalidateAfterImport(queryClient, hid),
  });
}

/** Confirms the chosen CSV detections one by one through the normal review endpoint (Q-142, Q-174). */
export function useConfirmReviewItems(): UseMutationResult<number, Error, string[]> {
  const { getToken, hid } = useHousehold();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await sendJson("POST", `/v1/households/${hid}/review-items/${id}/confirm`, getToken);
      }
      return ids.length;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["review-items", hid] });
      void queryClient.invalidateQueries({ queryKey: ["summary", hid] });
      void queryClient.invalidateQueries({ queryKey: ["plan", hid] });
      void queryClient.invalidateQueries({ queryKey: ["applied-changes", hid] });
    },
  });
}
