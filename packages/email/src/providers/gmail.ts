// Gmail REST client (BACKEND_PLAN §7.8.1): OAuth 2.0 with PKCE and offline access, scope gmail.readonly, a
// `users.watch` to Pub/Sub, `users.history.list` from the stored historyId, and a bounded `messages.list`
// backfill. Plain fetch against the documented endpoints (no SDK); `fetch` is injected, so tests never reach Google.
// https://developers.google.com/gmail/api/reference/rest
import { bearer, createHttp, form, type FetchLike, type Http } from "./http";
import {
  ProviderError,
  type AuthorizeInput,
  type BackfillInput,
  type BackfillPage,
  type ChangesPage,
  type GmailConfig,
  type MailProvider,
  type MessageMeta,
  type RefreshedToken,
  type StartWatchResult,
  type TokenGrant,
  type WatchState,
} from "./types";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 100;
/** A bounded fetch per run: the rest comes on the next page token or the next poll. */
const MAX_HISTORY_MESSAGES = 500;
/** Bounded concurrency for metadata fetches. */
const META_BATCH = 10;

const BACKFILL_KEYWORDS =
  'bill OR statement OR invoice OR receipt OR renewal OR premium OR policy OR subscription OR "payment due" OR "auto-renew" OR "open enrollment"';

/** BACKEND_PLAN §7.8.1: 13 months back, no promotions or social, the keywords, plus every watched sender. */
export function gmailBackfillQuery(lookbackDays: number, watchedDomains: readonly string[]): string {
  const days = Math.min(Math.max(1, Math.floor(lookbackDays)), 800);
  const domains = watchedDomains.filter((d) => /^[a-z0-9.-]+$/.test(d)).slice(0, 50);
  const keywords = `(${BACKFILL_KEYWORDS})`;
  const from = domains.map((d) => `from:${d}`);
  const either = [keywords, ...from].length > 1 ? `(${[keywords, ...from].join(" OR ")})` : keywords;
  return `newer_than:${days}d -category:promotions -category:social ${either}`;
}

interface GmailMessage {
  id?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: { name?: string; value?: string }[] };
}

function header(message: GmailMessage, name: string): string | null {
  const found = message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function toMeta(message: GmailMessage): MessageMeta | null {
  const id = message.id;
  const internal = Number(message.internalDate);
  if (!id || !Number.isFinite(internal)) return null;
  return {
    providerMessageId: id,
    receivedAt: new Date(internal).toISOString(),
    from: header(message, "From") ?? "",
    subject: header(message, "Subject") ?? "",
    labels: message.labelIds ?? [],
    listId: header(message, "List-Id"),
  };
}

export class GmailProvider implements MailProvider {
  readonly id = "gmail" as const;
  readonly #http: Http;

  constructor(
    private readonly config: GmailConfig,
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
      scope: GMAIL_SCOPE,
      access_type: "offline",
      // Without `consent` Google omits the refresh token for a returning user.
      prompt: "consent",
      include_granted_scopes: "false",
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
    const scopes = (body.scope ?? "").split(" ").filter(Boolean);
    if (!body.access_token || !body.refresh_token) {
      throw new ProviderError("permanent", "The provider did not grant offline access.");
    }
    if (!scopes.includes(GMAIL_SCOPE)) {
      throw new ProviderError("permanent", "Read access to the mailbox was not granted.");
    }
    const profile = await this.#http.json<{ emailAddress?: string }>(`${API}/profile`, {
      headers: bearer(body.access_token),
    });
    if (!profile.body.emailAddress) throw new ProviderError("permanent", "The mailbox address is unknown.");
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in ?? 3600,
      scopes,
      address: profile.body.emailAddress,
    };
  }

  async refresh(refreshToken: string): Promise<RefreshedToken> {
    const { body } = await this.#http.json<{ access_token?: string; expires_in?: number }>(TOKEN_URL, {
      method: "POST",
      ...form({
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
      }),
      // `invalid_grant`: the user removed the app, changed the password, or the token expired.
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
    return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3600, refreshToken: null };
  }

  async revoke(refreshToken: string): Promise<boolean> {
    try {
      await this.#http.json(REVOKE_URL, {
        method: "POST",
        ...form({ token: refreshToken }),
        expect: [200],
        // Google answers 400 `invalid_token` for a token that is already revoked or expired: the state we want.
        mapStatus: {
          400: (code) =>
            code === "invalid_token"
              ? new ProviderError("auth_revoked", "The grant was already revoked.")
              : new ProviderError("permanent", "The provider refused the revocation."),
        },
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth_revoked") return true;
      throw err;
    }
    return true;
  }

  async startWatch(accessToken: string): Promise<StartWatchResult> {
    if (!this.config.pubsubTopic) {
      // No Pub/Sub (local development): nothing to watch. Take the history position and report a window that the
      // daily renewal keeps moving, so the polling sync (email.sweep) is what finds new mail.
      const profile = await this.#http.json<{ historyId?: string }>(`${API}/profile`, {
        headers: bearer(accessToken),
      });
      if (!profile.body.historyId)
        throw new ProviderError("transient", "The provider sent an unreadable profile.");
      return {
        ref: null,
        expiresAt: new Date(this.now() + 7 * 86_400_000).toISOString(),
        cursor: profile.body.historyId,
      };
    }
    const { body } = await this.#http.json<{ historyId?: string; expiration?: string }>(`${API}/watch`, {
      method: "POST",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        topicName: this.config.pubsubTopic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      }),
    });
    const expiry = Number(body.expiration);
    if (!body.historyId || !Number.isFinite(expiry)) {
      throw new ProviderError("transient", "The provider sent an unreadable watch response.");
    }
    return { ref: null, expiresAt: new Date(expiry).toISOString(), cursor: body.historyId };
  }

  /** `users.watch` again resets the 7-day expiry. */
  async renewWatch(accessToken: string): Promise<WatchState> {
    const { ref, expiresAt } = await this.startWatch(accessToken);
    return { ref, expiresAt };
  }

  async stopWatch(accessToken: string): Promise<void> {
    await this.#http.json(`${API}/stop`, {
      method: "POST",
      headers: bearer(accessToken),
      expect: [200, 204, 404],
    });
  }

  async #metadata(accessToken: string, ids: readonly string[]): Promise<MessageMeta[]> {
    const out: MessageMeta[] = [];
    for (let i = 0; i < ids.length; i += META_BATCH) {
      const batch = ids.slice(i, i + META_BATCH);
      const got = await Promise.all(
        batch.map(async (id) => {
          const url = new URL(`${API}/messages/${encodeURIComponent(id)}`);
          url.searchParams.set("format", "metadata");
          for (const h of ["From", "Subject", "List-Id"]) url.searchParams.append("metadataHeaders", h);
          try {
            const { body } = await this.#http.json<GmailMessage>(url.toString(), {
              headers: bearer(accessToken),
            });
            return toMeta(body);
          } catch (err) {
            if (err instanceof ProviderError && err.kind === "not_found") return null; // deleted since
            throw err;
          }
        }),
      );
      for (const m of got) if (m) out.push(m);
    }
    return out;
  }

  async backfillPage(accessToken: string, input: BackfillInput): Promise<BackfillPage> {
    let cursor: string | null = null;
    if (input.pageToken === null) {
      const profile = await this.#http.json<{ historyId?: string }>(`${API}/profile`, {
        headers: bearer(accessToken),
      });
      cursor = profile.body.historyId ?? null;
    }
    const url = new URL(`${API}/messages`);
    url.searchParams.set("q", gmailBackfillQuery(input.lookbackDays, input.watchedDomains));
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    const { body } = await this.#http.json<{ messages?: { id: string }[]; nextPageToken?: string }>(
      url.toString(),
      { headers: bearer(accessToken) },
    );
    const messages = await this.#metadata(
      accessToken,
      (body.messages ?? []).map((m) => m.id),
    );
    return { messages, nextPageToken: body.nextPageToken ?? null, cursor };
  }

  async listChanges(accessToken: string, cursor: string): Promise<ChangesPage> {
    const ids = new Set<string>();
    let pageToken: string | null = null;
    let latest = cursor;
    do {
      const url = new URL(`${API}/history`);
      url.searchParams.set("startHistoryId", cursor);
      url.searchParams.set("historyTypes", "messageAdded");
      url.searchParams.set("labelId", "INBOX");
      url.searchParams.set("maxResults", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res: {
        body: {
          history?: { messagesAdded?: { message?: { id?: string } }[] }[];
          nextPageToken?: string;
          historyId?: string;
        };
      } = await this.#http.json(url.toString(), {
        headers: bearer(accessToken),
        // Google answers 404 for a startHistoryId that is too old.
        mapStatus: { 404: new ProviderError("cursor_expired", "The sync position is too old.") },
      });
      for (const h of res.body.history ?? []) {
        for (const added of h.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
      }
      latest = res.body.historyId ?? latest;
      pageToken = res.body.nextPageToken ?? null;
      if (ids.size >= MAX_HISTORY_MESSAGES && pageToken) {
        // Keep the cursor at the start so the next run continues; the unique index drops repeats.
        return { messages: await this.#metadata(accessToken, [...ids]), cursor };
      }
    } while (pageToken);
    return { messages: await this.#metadata(accessToken, [...ids]), cursor: latest };
  }

  async fetchRaw(accessToken: string, providerMessageId: string): Promise<Uint8Array> {
    const url = new URL(`${API}/messages/${encodeURIComponent(providerMessageId)}`);
    url.searchParams.set("format", "raw");
    const { body } = await this.#http.json<{ raw?: string }>(url.toString(), {
      headers: bearer(accessToken),
    });
    if (!body.raw) throw new ProviderError("not_found", "The message has no content.");
    return Uint8Array.from(Buffer.from(body.raw, "base64url"));
  }
}
