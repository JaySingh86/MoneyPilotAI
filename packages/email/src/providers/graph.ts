// Microsoft Graph client (BACKEND_PLAN §7.8.1): OAuth 2.0 with PKCE on the Microsoft identity platform (scopes
// `Mail.Read offline_access`, plus the identity scopes `openid email` to learn the mailbox address from the id
// token), a change-notification subscription on the inbox with `clientState`, and a delta query whose deltaLink is
// the sync cursor. Plain fetch; `fetch` is injected so tests never reach Microsoft.
// https://learn.microsoft.com/graph/api/resources/mail-api-overview
import { bearer, createHttp, form, type FetchLike, type Http } from "./http";
import {
  ProviderError,
  type AuthorizeInput,
  type BackfillInput,
  type BackfillPage,
  type ChangesPage,
  type GraphConfig,
  type MailProvider,
  type MessageMeta,
  type RefreshedToken,
  type StartWatchResult,
  type TokenGrant,
  type WatchState,
} from "./types";

export const GRAPH_SCOPES = ["Mail.Read", "offline_access", "openid", "email"] as const;
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const INBOX = "me/mailFolders('inbox')/messages";
/** Outlook message subscriptions last at most 4230 minutes (about 2.9 days). */
export const GRAPH_SUBSCRIPTION_MINUTES = 4200;
const SELECT = "id,receivedDateTime,from,subject,categories";
const MAX_PAGES_PER_RUN = 20;

interface GraphMessage {
  id?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string } };
  subject?: string;
  categories?: string[];
  "@removed"?: unknown;
}

function toMeta(m: GraphMessage): MessageMeta | null {
  if (m["@removed"] || !m.id || !m.receivedDateTime) return null;
  const received = Date.parse(m.receivedDateTime);
  if (!Number.isFinite(received)) return null;
  return {
    providerMessageId: m.id,
    receivedAt: new Date(received).toISOString(),
    from: m.from?.emailAddress?.address ?? "",
    subject: m.subject ?? "",
    labels: m.categories ?? [],
    listId: null,
  };
}

/**
 * A stored page token or deltaLink is only ever followed on Graph's own host: a tampered cursor must not make us
 * send the bearer token anywhere else.
 */
export function assertGraphUrl(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ProviderError("permanent", "The stored sync position is not a URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com") {
    throw new ProviderError("permanent", "The stored sync position points outside Microsoft Graph.");
  }
  return url.toString();
}

/**
 * The email claim of an id token received straight from the token endpoint over TLS. The signature is NOT verified:
 * the value is a display label only (it becomes the masked address and a keyed hash used to match a push), never an
 * identity, an authorization or a login decision.
 */
function idTokenEmail(idToken: string | undefined): string | null {
  const part = idToken?.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      email?: unknown;
      preferred_username?: unknown;
    };
    const value = typeof claims.email === "string" ? claims.email : claims.preferred_username;
    return typeof value === "string" && value.includes("@") ? value : null;
  } catch {
    return null;
  }
}

export class GraphProvider implements MailProvider {
  readonly id = "outlook" as const;
  readonly #http: Http;

  constructor(
    private readonly config: GraphConfig,
    fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.#http = createHttp(fetchImpl);
  }

  authorizationUrl({ state, codeChallenge }: AuthorizeInput): string {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: GRAPH_SCOPES.join(" "),
      prompt: "select_account",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string }): Promise<TokenGrant> {
    const { body } = await this.#http.json<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    }>(TOKEN_URL, {
      method: "POST",
      ...form({
        code,
        code_verifier: codeVerifier,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code",
      }),
      mapStatus: { 400: new ProviderError("auth_revoked", "The authorisation code was refused.") },
    });
    if (!body.access_token || !body.refresh_token) {
      throw new ProviderError("permanent", "The provider did not grant offline access.");
    }
    const scopes = (body.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.some((s) => s.toLowerCase().endsWith("mail.read"))) {
      throw new ProviderError("permanent", "Read access to the mailbox was not granted.");
    }
    const address = idTokenEmail(body.id_token);
    if (!address) throw new ProviderError("permanent", "The mailbox address is unknown.");
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in ?? 3600,
      scopes,
      address,
    };
  }

  async refresh(refreshToken: string): Promise<RefreshedToken> {
    const { body } = await this.#http.json<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>(TOKEN_URL, {
      method: "POST",
      ...form({
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
        scope: GRAPH_SCOPES.join(" "),
      }),
      // Only `invalid_grant` means the grant is gone (app removed, password changed, token expired). Any other 400
      // (for example `invalid_client` after a rotated secret) is our configuration: permanent, so jobs retry and
      // alert instead of deleting a sealed token whose grant is still live (WP-21 security re-review).
      mapStatus: {
        400: (code) =>
          code === "invalid_grant"
            ? new ProviderError("auth_revoked", "The mailbox grant is no longer valid.")
            : new ProviderError("permanent", "The provider refused the client configuration."),
      },
    });
    if (!body.access_token) throw new ProviderError("transient", "The provider sent no access token.");
    return {
      accessToken: body.access_token,
      expiresInSeconds: body.expires_in ?? 3600,
      refreshToken: body.refresh_token ?? null,
    };
  }

  /**
   * Microsoft has no per-token revocation endpoint for this scope set (revoking sessions needs a write scope we do
   * not ask for). The subscription is deleted and the token discarded; the person can also remove the app at
   * account.microsoft.com. Returns false so the caller records that it could not revoke at the provider.
   */
  async revoke(): Promise<boolean> {
    return false;
  }

  async startWatch(accessToken: string, { clientState }: { clientState: string }): Promise<StartWatchResult> {
    const expiration = new Date(this.now() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString();
    const { body } = await this.#http.json<{ id?: string; expirationDateTime?: string }>(
      `${GRAPH}/subscriptions`,
      {
        method: "POST",
        headers: { ...bearer(accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          changeType: "created",
          notificationUrl: this.config.notificationUrl,
          resource: INBOX,
          expirationDateTime: expiration,
          clientState,
        }),
        expect: [201],
      },
    );
    if (!body.id || !body.expirationDateTime) {
      throw new ProviderError("transient", "The provider sent an unreadable subscription.");
    }
    return { ref: body.id, expiresAt: new Date(body.expirationDateTime).toISOString(), cursor: null };
  }

  async renewWatch(
    accessToken: string,
    { ref, clientState }: { ref: string | null; clientState: string },
  ): Promise<WatchState> {
    if (!ref) {
      const { cursor: _cursor, ...state } = await this.startWatch(accessToken, { clientState });
      return state;
    }
    const expiration = new Date(this.now() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString();
    try {
      const { body } = await this.#http.json<{ id?: string; expirationDateTime?: string }>(
        `${GRAPH}/subscriptions/${encodeURIComponent(ref)}`,
        {
          method: "PATCH",
          headers: { ...bearer(accessToken), "content-type": "application/json" },
          body: JSON.stringify({ expirationDateTime: expiration }),
        },
      );
      return { ref, expiresAt: new Date(body.expirationDateTime ?? expiration).toISOString() };
    } catch (err) {
      // The subscription lapsed or was removed: make a new one.
      if (err instanceof ProviderError && err.kind === "not_found") {
        const { cursor: _cursor, ...state } = await this.startWatch(accessToken, { clientState });
        return state;
      }
      throw err;
    }
  }

  async stopWatch(accessToken: string, ref: string | null): Promise<void> {
    if (!ref) return;
    await this.#http.json(`${GRAPH}/subscriptions/${encodeURIComponent(ref)}`, {
      method: "DELETE",
      headers: bearer(accessToken),
      expect: [200, 204, 404],
    });
  }

  /** Follows nextLinks until a deltaLink, or for at most `limit` pages. */
  async #delta(
    accessToken: string,
    start: string,
    limit: number,
  ): Promise<{ messages: MessageMeta[]; nextLink: string | null; deltaLink: string | null }> {
    const messages: MessageMeta[] = [];
    let link: string | null = start;
    for (let page = 0; page < limit && link; page++) {
      const res: {
        body: { value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
      } = await this.#http.json(assertGraphUrl(link), {
        headers: { ...bearer(accessToken), prefer: "odata.maxpagesize=100" },
        mapStatus: { 410: new ProviderError("cursor_expired", "The sync position is too old.") },
      });
      for (const m of res.body.value ?? []) {
        const meta = toMeta(m);
        if (meta) messages.push(meta);
      }
      if (res.body["@odata.deltaLink"])
        return { messages, nextLink: null, deltaLink: res.body["@odata.deltaLink"] };
      link = res.body["@odata.nextLink"] ?? null;
    }
    return { messages, nextLink: link, deltaLink: null };
  }

  async backfillPage(accessToken: string, input: BackfillInput): Promise<BackfillPage> {
    let start = input.pageToken;
    if (start === null) {
      const url = new URL(`${GRAPH}/${INBOX}/delta`);
      url.searchParams.set("$select", SELECT);
      url.searchParams.set("$filter", `receivedDateTime ge ${input.sinceIso}`);
      start = url.toString();
    }
    // One page per call so the worker can save the resume point after every page.
    const out = await this.#delta(accessToken, start, 1);
    return { messages: out.messages, nextPageToken: out.nextLink, cursor: out.deltaLink };
  }

  async listChanges(accessToken: string, cursor: string): Promise<ChangesPage> {
    const out = await this.#delta(accessToken, cursor, MAX_PAGES_PER_RUN);
    // Unfinished (too many pages): continue from the nextLink on the next run; the unique index drops repeats.
    return { messages: out.messages, cursor: out.deltaLink ?? out.nextLink ?? cursor };
  }

  async fetchRaw(accessToken: string, providerMessageId: string): Promise<Uint8Array> {
    return this.#http.bytes(`${GRAPH}/me/messages/${encodeURIComponent(providerMessageId)}/$value`, {
      headers: bearer(accessToken),
    });
  }
}
