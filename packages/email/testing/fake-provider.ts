// In-memory Gmail and Microsoft Graph, behind the same `MailProvider` port as the real clients (WP-21). Covers
// the consent step with PKCE verification, token exchange and refresh (Microsoft rotates refresh tokens), watch and
// subscription state with expiry, history/delta cursors that can expire, paged backfill with injectable failures,
// and raw messages. No network, no real inbox. Tests only.
import { createHash, randomBytes } from "node:crypto";
import {
  ProviderError,
  type AuthorizeInput,
  type BackfillInput,
  type BackfillPage,
  type ChangesPage,
  type MailProvider,
  type MailProviderId,
  type MessageMeta,
  type RefreshedToken,
  type StartWatchResult,
  type TokenGrant,
  type WatchState,
} from "../src/providers/types";

export interface FakeProviderOptions {
  /** Epoch ms. Default: Date.now. */
  now?: () => number;
  /** Messages per backfill page. Default 2, so tests cross page boundaries. */
  pageSize?: number;
  /** How long a watch or subscription lasts. Default: 7 days (Gmail) or 4200 minutes (Graph). */
  watchTtlMs?: number;
}

interface Account {
  address: string;
  messages: MessageMeta[];
  /** Cursors below this index are too old. */
  cursorFloor: number;
  revoked: boolean;
  refreshToken: string | null;
  accessTokens: Set<string>;
  watch: { ref: string | null; expiresAt: number } | null;
}

interface PendingCode {
  address: string;
  challenge: string;
  state: string;
}

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const GRAPH_SCOPES = ["Mail.Read", "offline_access", "openid", "email"];

export class FakeMailProvider implements MailProvider {
  /** Every port call, in order, by name (`exchangeCode`, `refresh`, `revoke`, `startWatch`, ...). */
  readonly calls: string[] = [];
  /** Page tokens handed out by `backfillPage`, to assert resumption. */
  readonly backfillPageTokens: (string | null)[] = [];
  readonly #accounts = new Map<string, Account>();
  readonly #codes = new Map<string, PendingCode>();
  readonly #failures = new Map<string, { error: ProviderError; times: number; after: number }>();
  readonly #now: () => number;
  readonly #pageSize: number;
  readonly #ttl: number;
  #counter = 0;

  constructor(
    readonly id: MailProviderId,
    options: FakeProviderOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#pageSize = options.pageSize ?? 2;
    this.#ttl = options.watchTtlMs ?? (id === "gmail" ? 7 * 86_400_000 : 4200 * 60_000);
  }

  // ===== Test controls =====

  /** Makes `address` an existing mailbox with no messages. Idempotent. */
  account(address: string): Account {
    const key = address.toLowerCase();
    let a = this.#accounts.get(key);
    if (!a) {
      a = {
        address: key,
        messages: [],
        cursorFloor: 0,
        revoked: false,
        refreshToken: null,
        accessTokens: new Set(),
        watch: null,
      };
      this.#accounts.set(key, a);
    }
    return a;
  }

  /** The person approving in their browser: checks the URL, returns what the provider would redirect back with. */
  consent(authorizationUrl: string, address: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (!state || !challenge || url.searchParams.get("code_challenge_method") !== "S256") {
      throw new Error("The authorization URL has no state or no S256 PKCE challenge.");
    }
    this.account(address);
    const code = `code-${++this.#counter}-${randomBytes(6).toString("hex")}`;
    this.#codes.set(code, { address: address.toLowerCase(), challenge, state });
    return { code, state };
  }

  /** A new message in the inbox. */
  deliver(address: string, partial: Partial<MessageMeta> = {}): MessageMeta {
    const a = this.account(address);
    const n = ++this.#counter;
    const meta: MessageMeta = {
      providerMessageId: partial.providerMessageId ?? `msg-${this.id}-${n}`,
      receivedAt: partial.receivedAt ?? new Date(this.#now() - n * 1000).toISOString(),
      from: partial.from ?? "Northgate Insurance <billing@northgate-insurance.example>",
      subject: partial.subject ?? "Your statement is ready",
      labels: partial.labels ?? [],
      listId: partial.listId ?? null,
    };
    a.messages.push(meta);
    return meta;
  }

  /** The person removes the app from their account: every token stops working. */
  revokeGrant(address: string): void {
    const a = this.account(address);
    a.revoked = true;
    a.accessTokens.clear();
  }

  /** History/delta cursors issued so far become too old (Gmail 404, Graph 410). */
  expireCursors(address: string): void {
    const a = this.account(address);
    a.cursorFloor = a.messages.length;
  }

  /** Makes the next `times` calls of `call` throw, after letting `after` calls through. */
  failNext(call: string, error: ProviderError, options: { times?: number; after?: number } = {}): void {
    this.#failures.set(call, { error, times: options.times ?? 1, after: options.after ?? 0 });
  }

  watchOf(address: string): { active: boolean; ref: string | null; expiresAt: string | null } {
    const w = this.account(address).watch;
    return {
      active: w !== null,
      ref: w?.ref ?? null,
      expiresAt: w ? new Date(w.expiresAt).toISOString() : null,
    };
  }

  /** The mailbox forgets its watch without telling us (a lapsed Graph subscription). */
  dropWatch(address: string): void {
    this.account(address).watch = null;
  }

  isRevoked(address: string): boolean {
    return this.account(address).revoked;
  }

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }

  // ===== MailProvider =====

  authorizationUrl({ state, codeChallenge }: AuthorizeInput): string {
    this.calls.push("authorizationUrl");
    const host =
      this.id === "gmail"
        ? "https://accounts.fake-google.test/auth"
        : "https://login.fake-microsoft.test/authorize";
    const url = new URL(host);
    url.search = new URLSearchParams({
      client_id: "fake-client",
      response_type: "code",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string }): Promise<TokenGrant> {
    this.#enter("exchangeCode");
    const pending = this.#codes.get(code);
    this.#codes.delete(code); // single use
    if (!pending) throw new ProviderError("auth_revoked", "The authorisation code was refused.");
    const challenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
    if (challenge !== pending.challenge) {
      throw new ProviderError("auth_revoked", "The authorisation code was refused.");
    }
    const a = this.account(pending.address);
    a.revoked = false;
    a.refreshToken = `rt-${++this.#counter}-${randomBytes(8).toString("hex")}`;
    const accessToken = this.#issueAccess(a);
    return {
      accessToken,
      refreshToken: a.refreshToken,
      expiresInSeconds: 3600,
      scopes: this.id === "gmail" ? GMAIL_SCOPES : GRAPH_SCOPES,
      address: a.address,
    };
  }

  async refresh(refreshToken: string): Promise<RefreshedToken> {
    this.#enter("refresh");
    const a = [...this.#accounts.values()].find((x) => x.refreshToken === refreshToken);
    if (!a || a.revoked) throw new ProviderError("auth_revoked", "The mailbox grant is no longer valid.");
    let rotated: string | null = null;
    if (this.id === "outlook") {
      rotated = `rt-${++this.#counter}-${randomBytes(8).toString("hex")}`;
      a.refreshToken = rotated;
    }
    return { accessToken: this.#issueAccess(a), expiresInSeconds: 3600, refreshToken: rotated };
  }

  async revoke(refreshToken: string): Promise<boolean> {
    this.#enter("revoke");
    const a = [...this.#accounts.values()].find((x) => x.refreshToken === refreshToken);
    if (this.id === "outlook") return false; // no per-token revocation, like the real service
    if (a) {
      a.revoked = true;
      a.accessTokens.clear();
    }
    return true;
  }

  async startWatch(accessToken: string): Promise<StartWatchResult> {
    this.#enter("startWatch");
    const a = this.#auth(accessToken);
    a.watch = {
      ref: this.id === "gmail" ? null : `sub-${++this.#counter}`,
      expiresAt: this.#now() + this.#ttl,
    };
    return {
      ref: a.watch.ref,
      expiresAt: new Date(a.watch.expiresAt).toISOString(),
      cursor: this.id === "gmail" ? String(a.messages.length) : null,
    };
  }

  async renewWatch(accessToken: string, input: { ref: string | null }): Promise<WatchState> {
    this.#enter("renewWatch");
    const a = this.#auth(accessToken);
    if (this.id === "outlook" && (!a.watch || a.watch.ref !== input.ref)) {
      // The subscription lapsed: a new one, like the real client.
      a.watch = { ref: `sub-${++this.#counter}`, expiresAt: this.#now() + this.#ttl };
    } else {
      a.watch = { ref: a.watch?.ref ?? null, expiresAt: this.#now() + this.#ttl };
    }
    return { ref: a.watch.ref, expiresAt: new Date(a.watch.expiresAt).toISOString() };
  }

  async stopWatch(accessToken: string): Promise<void> {
    this.#enter("stopWatch");
    const a = this.#auth(accessToken);
    a.watch = null;
  }

  async backfillPage(accessToken: string, input: BackfillInput): Promise<BackfillPage> {
    this.#enter("backfillPage");
    const a = this.#auth(accessToken);
    this.backfillPageTokens.push(input.pageToken);
    const since = Date.parse(input.sinceIso);
    const eligible = a.messages.filter((m) => Date.parse(m.receivedAt) >= since);
    const offset = input.pageToken === null ? 0 : Number(/^p(\d+)$/.exec(input.pageToken)?.[1]);
    if (!Number.isInteger(offset)) throw new ProviderError("permanent", "The page token is not valid.");
    const messages = eligible.slice(offset, offset + this.#pageSize);
    const last = offset + this.#pageSize >= eligible.length;
    return {
      messages,
      nextPageToken: last ? null : `p${offset + this.#pageSize}`,
      cursor:
        this.id === "gmail"
          ? offset === 0
            ? String(a.messages.length)
            : null
          : last
            ? `delta:${a.messages.length}`
            : null,
    };
  }

  async listChanges(accessToken: string, cursor: string): Promise<ChangesPage> {
    this.#enter("listChanges");
    const a = this.#auth(accessToken);
    const index = Number(cursor.replace(/^delta:/, ""));
    if (!Number.isInteger(index) || index < 0)
      throw new ProviderError("permanent", "The cursor is not valid.");
    if (index < a.cursorFloor) throw new ProviderError("cursor_expired", "The sync position is too old.");
    const next = String(a.messages.length);
    return {
      messages: a.messages.slice(index),
      cursor: this.id === "gmail" ? next : `delta:${next}`,
    };
  }

  async fetchRaw(accessToken: string, providerMessageId: string): Promise<Uint8Array> {
    this.#enter("fetchRaw");
    const a = this.#auth(accessToken);
    const m = a.messages.find((x) => x.providerMessageId === providerMessageId);
    if (!m) throw new ProviderError("not_found", "The provider has no such resource.");
    return Buffer.from(
      `From: ${m.from}\r\nSubject: ${m.subject}\r\nDate: ${new Date(m.receivedAt).toUTCString()}\r\n\r\nBody of ${m.providerMessageId}\r\n`,
    );
  }

  // ===== internals =====

  #enter(call: string): void {
    this.calls.push(call);
    const f = this.#failures.get(call);
    if (!f) return;
    if (f.after > 0) {
      f.after--;
      return;
    }
    if (f.times > 0) {
      f.times--;
      if (f.times === 0) this.#failures.delete(call);
      throw f.error;
    }
  }

  #issueAccess(a: Account): string {
    const token = `at-${++this.#counter}-${randomBytes(8).toString("hex")}`;
    a.accessTokens.add(token);
    return token;
  }

  #auth(accessToken: string): Account {
    const a = [...this.#accounts.values()].find((x) => x.accessTokens.has(accessToken));
    if (!a || a.revoked) throw new ProviderError("auth_revoked", "The provider rejected the credentials.");
    return a;
  }
}

/** A fake Gmail with a clock. */
export const createFakeGmail = (options?: FakeProviderOptions): FakeMailProvider =>
  new FakeMailProvider("gmail", options);
/** A fake Microsoft Graph with a clock. */
export const createFakeGraph = (options?: FakeProviderOptions): FakeMailProvider =>
  new FakeMailProvider("outlook", options);

/** The base64 data of a Pub/Sub push body for a Gmail watch notification (the payload we never trust beyond routing). */
export function gmailPushBody(
  address: string,
  historyId: string,
): {
  message: { data: string; messageId: string };
  subscription: string;
} {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: address, historyId })).toString("base64"),
      messageId: `pubsub-${randomBytes(6).toString("hex")}`,
    },
    subscription: "projects/fake/subscriptions/mp-gmail",
  };
}
