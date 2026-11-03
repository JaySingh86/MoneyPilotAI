// The one database pool of the API process (WP-12, replacing per-module wiring such as WP-06's). Modules do
// not open connections: they reach this pool through the API runtime (`auth/runtime.ts`), and the process
// that created it closes it on shutdown, after the HTTP server has drained.
import { createApiDb, type ApiDb } from "@mp/db";

export interface SharedDb {
  readonly db: ApiDb;
  /** Ends the pool. Safe to call more than once. */
  close(): Promise<void>;
}

export interface SharedDbOptions {
  connectionString: string;
  /** Pool size. Default 10. */
  max?: number;
}

export function createSharedDb(options: SharedDbOptions): SharedDb {
  const db = createApiDb({ connectionString: options.connectionString, max: options.max ?? 10 });
  let closing: Promise<void> | null = null;
  return {
    db,
    close() {
      closing ??= db.close();
      return closing;
    },
  };
}

/** What `installShutdown` needs from the app and the process (kept structural so tests can fake both). */
export interface Closable {
  close(): Promise<unknown>;
}
export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
}

/**
 * Closes the HTTP server first (in-flight requests finish), then the pool, on SIGINT or SIGTERM. Returns
 * the shutdown function so the caller (and tests) can run it directly.
 */
export function installShutdown(
  app: Closable,
  pool: Pick<SharedDb, "close">,
  signals: SignalSource,
  onDone: (error: unknown) => void,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    running ??= (async () => {
      let failure: unknown;
      try {
        await app.close();
      } catch (err) {
        failure = err;
      }
      try {
        await pool.close();
      } catch (err) {
        failure ??= err;
      }
      onDone(failure);
    })();
    return running;
  };
  signals.once("SIGINT", () => void shutdown());
  signals.once("SIGTERM", () => void shutdown());
  return shutdown;
}
