// The API client: the generated, typed client from @mp/contracts for what the contracts cover, and a
// small typed GET for the planning endpoints that WP-12 will add to the contracts.
import { createApiClient } from "@mp/contracts/client";
import type { ApiClient } from "@mp/contracts/client";
import { API_BASE_URL } from "../config";

export type TokenProvider = () => Promise<string | null>;

/** RFC 9457 problem (`application/problem+json`) as thrown by {@link ApiError}. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The problem's stable `reason`, when it has one (plan_not_ready, invite acceptance). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Sends the request, with the bearer token only when it goes to the API's own origin (so a URL that
 * ever points elsewhere never gets the token), and never follows a redirect (a redirect could carry
 * the token to another origin).
 */
export async function authorized(
  request: Request,
  getToken: TokenProvider,
  baseUrl: string = API_BASE_URL,
): Promise<Response> {
  if (new URL(request.url).origin === new URL(baseUrl).origin) {
    const token = await getToken();
    if (token) request.headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(request, { redirect: "error" });
}

export function createClient(getToken: TokenProvider, baseUrl: string = API_BASE_URL): ApiClient {
  return createApiClient({ baseUrl, fetch: (request) => authorized(request, getToken, baseUrl) });
}

/** Turns a problem+json response into an {@link ApiError}. */
export async function toApiError(response: Response): Promise<ApiError> {
  let code = "internal_error";
  let detail = "Something went wrong.";
  let reason: string | undefined;
  try {
    const body = (await response.json()) as {
      code?: string;
      detail?: string;
      title?: string;
      reason?: string;
    };
    code = body.code ?? code;
    detail = body.detail ?? body.title ?? detail;
    reason = body.reason;
  } catch {
    // Not JSON: keep the defaults.
  }
  return new ApiError(response.status, code, detail, reason);
}

/** GET a JSON resource that the generated client does not describe yet (planning, WP-12). */
export async function getJson<T>(
  path: string,
  getToken: TokenProvider,
  query: Record<string, string | undefined> = {},
  baseUrl: string = API_BASE_URL,
): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const response = await authorized(
    new Request(url, { headers: { accept: "application/json" }, redirect: "error" }),
    getToken,
    baseUrl,
  );
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** A fresh Idempotency-Key: one per user action (BACKEND_PLAN §8.1). */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Sends a JSON request with a body (POST, PUT, PATCH) or none (DELETE). Returns null for 204. */
export async function sendJson<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  getToken: TokenProvider,
  body?: unknown,
  baseUrl: string = API_BASE_URL,
  options: { idempotencyKey?: string } = {},
): Promise<T | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  // Every write carries a key (routes that create things require one). A caller that may send the same action
  // twice, such as a retry after step-up, passes the same key to both calls.
  headers["idempotency-key"] = options.idempotencyKey ?? newIdempotencyKey();
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const response = await authorized(request, getToken, baseUrl);
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null;
  return (await response.json()) as T;
}
