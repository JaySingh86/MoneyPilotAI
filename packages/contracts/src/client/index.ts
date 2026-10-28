// Typed API client for web and mobile (ADR-008): openapi-fetch over the types generated from the API's
// OpenAPI document (`pnpm contracts:gen`). Errors arrive typed as `Problem` (RFC 9457).
import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "../openapi/schema";

export type { components, paths } from "../openapi/schema";

export type ApiClient = Client<paths>;

/** `createApiClient({ baseUrl: "https://api.example.com", headers: { authorization: `Bearer ${jwt}` } })` */
export function createApiClient(options: ClientOptions): ApiClient {
  return createClient<paths>(options);
}
