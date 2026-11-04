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
async function toApiError(response: Response): Promise<ApiError> {
  let code = "internal_error";
  let detail = "Something went wrong.";
  try {
    const body = (await response.json()) as { code?: string; detail?: string; title?: string };
    code = body.code ?? code;
    detail = body.detail ?? body.title ?? detail;
  } catch {
    // Not JSON: keep the defaults.
  }
  return new ApiError(response.status, code, detail);
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
