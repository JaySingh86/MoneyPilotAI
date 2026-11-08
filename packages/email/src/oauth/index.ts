// The narrow surface of @mp/email that apps/api may import (WP-21, hard rule 7): OAuth consent and code exchange,
// revoking a grant that was just made, PKCE and state helpers, the address hash and the Graph clientState check.
// Deliberately absent: `refresh`, `listChanges`, `backfillPage`, `fetchRaw`, watches. Reading a mailbox is the worker's
// job; the API never holds an access token longer than the callback request. A dependency-cruiser rule allows
// apps/api to import this file and nothing else in packages/email.
import { createProvidersFromEnv, ProviderConfigError, type ProviderEnv } from "../providers/env";
import type { FetchLike } from "../providers/http";
import type { MailProviderId, OAuthClient } from "../providers/types";

export { addressHash, graphClientState, verifyGraphClientState } from "../providers/address";
export { generatePkce, generateState, hashState, pkceChallenge, type Pkce } from "../providers/pkce";
export { ProviderConfigError, type ProviderEnv };
export { ProviderError, type MailProviderId, type OAuthClient, type TokenGrant } from "../providers/types";

/** The OAuth-only view of each configured provider. */
export function createOAuthClientsFromEnv(
  env: ProviderEnv,
  options: { fetch?: FetchLike; now?: () => number } = {},
): Partial<Record<MailProviderId, OAuthClient>> {
  const providers = createProvidersFromEnv(env, options);
  const out: Partial<Record<MailProviderId, OAuthClient>> = {};
  for (const id of ["gmail", "outlook"] as const) {
    const p = providers[id];
    if (!p) continue;
    out[id] = {
      id: p.id,
      authorizationUrl: (input) => p.authorizationUrl(input),
      exchangeCode: (input) => p.exchangeCode(input),
      revoke: (refreshToken) => p.revoke(refreshToken),
    };
  }
  return out;
}
