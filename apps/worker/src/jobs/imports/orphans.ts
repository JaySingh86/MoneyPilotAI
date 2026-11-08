// Job `imports.orphans` (WP-32): deletes uploaded files nobody is going to process.
//
// The upload URL pins the size and type of one object, but it cannot stop an upload that is never followed by
// `/process`, and the bucket may hold keys with no `imports` row at all. After a grace period (IMPORTS_ORPHAN_HOURS,
// default 24) an object under `imports/` is deleted when:
//   - its key is not `imports/<household>/<import>.csv`, or no such import row exists for that household;
//   - its import is still `uploaded` (never processed); or
//   - its import no longer points at a file (`s3_key` is null: the file should be gone already).
// An import that is `needs_mapping` keeps its file until a person chooses a mapping; `processing` and finished
// imports with a file are handled by imports.process and imports.sweep. Idempotent: running it twice deletes nothing
// more. Nothing is logged but counts (hard rule 8).
import type { WorkerDb } from "@mp/db";
import * as repo from "./repo";
import type { ImportFileStore } from "./storage";

export const IMPORTS_ORPHANS_QUEUE = "imports.orphans";
/** Hourly, at minute 17. */
export const IMPORTS_ORPHANS_CRON = "17 * * * *";
export const DEFAULT_ORPHAN_HOURS = 24;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Strict UUIDs: a malformed key must never reach a uuid cast and abort the whole sweep (WP-32 re-review).
const KEY = new RegExp(`^imports/(${UUID})/(${UUID})\\.csv$`, "i");
const HOUR_MS = 3_600_000;

export interface ImportsOrphansDeps {
  db: WorkerDb;
  store: ImportFileStore;
  /** Epoch milliseconds. */
  now: () => number;
  maxAgeHours: number;
}

/** `IMPORTS_ORPHAN_HOURS` as a positive number, else the default. */
export function orphanHoursFromEnv(env: NodeJS.ProcessEnv): number {
  const hours = Number(env.IMPORTS_ORPHAN_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_ORPHAN_HOURS;
}

export async function handleImportsOrphans(
  deps: ImportsOrphansDeps,
): Promise<{ listed: number; deleted: number }> {
  if (!deps.store.list) return { listed: 0, deleted: 0 };
  const objects = await deps.store.list("imports/");
  const cutoff = deps.now() - deps.maxAgeHours * HOUR_MS;
  let deleted = 0;
  for (const object of objects) {
    if (object.lastModifiedMs > cutoff) continue;
    if (await isOrphan(deps.db, object.key)) {
      await deps.store.delete(object.key);
      deleted++;
    }
  }
  return { listed: objects.length, deleted };
}

async function isOrphan(db: WorkerDb, key: string): Promise<boolean> {
  const match = KEY.exec(key);
  if (!match) return true;
  const [, householdId, importId] = match as unknown as [string, string, string];
  // RLS scopes the read to that household; a household that does not exist simply has no rows.
  const state = await db.withJobTx(householdId.toLowerCase(), (tx) =>
    repo.importFileState(tx, householdId.toLowerCase(), importId.toLowerCase()),
  );
  if (!state) return true;
  return state.status === "uploaded" || !state.hasKey;
}
