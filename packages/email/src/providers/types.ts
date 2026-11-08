// Mailbox provider port (BACKEND_PLAN §7.8.1). The real Gmail and Graph clients and the in-memory fakes in
// `@mp/email/testing` implement it. Metadata only: `MessageMeta` carries From, Subject, Date and labels so the
// prefilter can decide; bodies come from `fetchRaw` later, in the processing pipeline, and are never stored.
//
// Nothing here logs. Errors never carry a token, an address or a subject (hard rules 7 and 8).

export type MailProviderId = "gmail" | "outlook";

export interface MessageMeta {
  providerMessageId: string;
  /** UTC instant, ISO 8601. */
  receivedAt: string;
  /** Raw From header. */
  from: string;
  /** Used for the prefilter in memory only; the connector never stores it. */
  subject: string;
  /** Provider labels or categories, e.g. Gmail `CATEGORY_PROMOTIONS`. */
  labels: string[];
  listId: string | null;
}

export interface TokenGrant {
  accessToken: string;
  /** Always present: a grant without one is refused (we ask for offline access). */
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
  /** The mailbox's address, from the provider. Masked and hashed by the caller; never stored. */
  address: string;
}

export interface RefreshedToken {
  accessToken: string;
  expiresInSeconds: number;
  /** Set when the provider rotated the refresh token (Microsoft does); store the new one. */
  refreshToken: string | null;
}

export interface WatchState {
  /** Provider reference to renew or stop it (a Graph subscription id; null for Gmail). */
  ref: string | null;
  /** UTC instant, ISO 8601. */
  expiresAt: string;
}

export interface StartWatchResult extends WatchState {
  /** Gmail: the mailbox's current historyId. Null for Graph (its delta cursor comes from backfill). */
  cursor: string | null;
}

export interface BackfillPage {
  messages: MessageMeta[];
  /** Resume point for the next call; null on the last page. */
  nextPageToken: string | null;
  /**
   * The cursor for `listChanges`, once known: Gmail returns it with the first page (the historyId at the start,
   * so nothing that arrives during the backfill is missed); Graph returns it with the last page (the deltaLink).
   */
  cursor: string | null;
}

export interface BackfillInput {
  /** The start of the window, UTC ISO 8601 (Graph filters on it). */
  sinceIso: string;
  /** The same window in days (Gmail's `newer_than`). 13 months is 395. */
  lookbackDays: number;
  pageToken: string | null;
  /** Provider domains of the household's items, added to Gmail's query as `from:` clauses. */
  watchedDomains: readonly string[];
}

export interface ChangesPage {
  messages: MessageMeta[];
  cursor: string;
}

export type ProviderErrorKind =
  /** The grant is gone (user removed the app, password change, token expired). Needs a new connection. */
  | "auth_revoked"
  | "rate_limited"
  /** The sync cursor is too old (Gmail 404 on history, Graph 410). Fall back to a bounded listing. */
  | "cursor_expired"
  | "not_found"
  | "transient"
  | "permanent";

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    readonly kind: ProviderErrorKind,
    /** A fixed description; never provider response text, which could carry an address or a subject. */
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface AuthorizeInput {
  state: string;
  /** PKCE S256 challenge. */
  codeChallenge: string;
}

/** What the API may do with a provider: send a person to consent, turn the code into a grant, undo a grant. */
export type OAuthClient = Pick<MailProvider, "id" | "authorizationUrl" | "exchangeCode" | "revoke">;

export interface MailProvider {
  readonly id: MailProviderId;

  authorizationUrl(input: AuthorizeInput): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<TokenGrant>;
  refresh(refreshToken: string): Promise<RefreshedToken>;
  /** Revokes the grant. Returns false where the provider has no such call (Microsoft); never throws on 4xx. */
  revoke(refreshToken: string): Promise<boolean>;

  startWatch(accessToken: string, input: { clientState: string }): Promise<StartWatchResult>;
  renewWatch(accessToken: string, input: { ref: string | null; clientState: string }): Promise<WatchState>;
  stopWatch(accessToken: string, ref: string | null): Promise<void>;

  backfillPage(accessToken: string, input: BackfillInput): Promise<BackfillPage>;
  listChanges(accessToken: string, cursor: string): Promise<ChangesPage>;
  /** The full RFC 822 message, for the processing pipeline. Held in memory only. */
  fetchRaw(accessToken: string, providerMessageId: string): Promise<Uint8Array>;
}

export interface MailProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Our callback URL, `{API origin}/v1/email-connections/{provider}/callback`. */
  redirectUri: string;
}

export interface GmailConfig extends MailProviderConfig {
  /** `projects/{project}/topics/{topic}` the Gmail watch publishes to. Omitted locally (no public endpoint): no watch is
   * created and the polling sync finds new mail. */
  pubsubTopic?: string;
}

export interface GraphConfig extends MailProviderConfig {
  /** Public HTTPS URL Graph posts change notifications to (`/webhooks/graph`). */
  notificationUrl: string;
}
