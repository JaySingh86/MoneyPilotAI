// Storage behind the Idempotency-Key plugin. Keys are scoped per user, like the WP-03
// `idempotency_keys` table (primary key (user_id, key), purged after 24 h by retention.purge).

/** Stored keys answer repeats for 24 hours (BACKEND_PLAN §8.1). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Bodies larger than this are not stored; the replay carries status, Location and ETag only. */
export const MAX_STORED_BODY_BYTES = 64 * 1024;

export interface StoredResponse {
  statusCode: number;
  /** Replayed headers (content-type, location, etag). */
  headers: Record<string, string>;
  /** Serialized body; null for an empty response or one over `MAX_STORED_BODY_BYTES`. */
  body: string | null;
  /** True when the original body was over the cap and was dropped. */
  bodyOmitted?: boolean;
}

export interface IdempotencyScope {
  userId: string;
  key: string;
}

export type BeginResult =
  /** First use: the caller owns the key and must `complete` or `release` it. */
  | { kind: "started" }
  /** A completed request with the same fingerprint: replay this response. */
  | { kind: "replay"; response: StoredResponse }
  /** The key was used for a different request (method, path or body). */
  | { kind: "mismatch" }
  /** The first request with this key is still running. */
  | { kind: "in_progress" };

export interface IdempotencyStore {
  /**
   * Atomically claims `scope` for a request with `requestHash`, or reports what is already stored.
   * Records older than the TTL count as absent.
   */
  begin(scope: IdempotencyScope, requestHash: string, now: number): Promise<BeginResult>;
  /** Stores the response for a started key. */
  complete(scope: IdempotencyScope, response: StoredResponse): Promise<void>;
  /** Forgets a started key (5xx or aborted request), so the client can retry with it. */
  release(scope: IdempotencyScope): Promise<void>;
}

interface Entry {
  requestHash: string;
  createdAt: number;
  response: StoredResponse | null;
}

/**
 * Process-local store for tests and single-process development.
 * TODO(WP-05+): add `DbIdempotencyStore` on the WP-03 `idempotency_keys` table through withHouseholdTx
 * (RLS `user_id = app_user_id()`): `begin` = `insert ... on conflict (user_id, key) do nothing` then select
 * (a row older than 24 h is replaced), `complete` = update `response` / `status_code`, `release` = delete.
 * Use it in apps/api/src/index.ts once the API has a database pool.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = IDEMPOTENCY_TTL_MS) {}

  private id(scope: IdempotencyScope): string {
    return `${scope.userId}\u0000${scope.key}`;
  }

  async begin(scope: IdempotencyScope, requestHash: string, now: number): Promise<BeginResult> {
    const id = this.id(scope);
    const entry = this.entries.get(id);
    if (entry && now - entry.createdAt < this.ttlMs) {
      if (entry.requestHash !== requestHash) return { kind: "mismatch" };
      return entry.response ? { kind: "replay", response: entry.response } : { kind: "in_progress" };
    }
    this.entries.set(id, { requestHash, createdAt: now, response: null });
    this.sweep(now);
    return { kind: "started" };
  }

  async complete(scope: IdempotencyScope, response: StoredResponse): Promise<void> {
    const entry = this.entries.get(this.id(scope));
    if (entry) entry.response = response;
  }

  async release(scope: IdempotencyScope): Promise<void> {
    this.entries.delete(this.id(scope));
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs) this.entries.delete(id);
    }
  }
}
