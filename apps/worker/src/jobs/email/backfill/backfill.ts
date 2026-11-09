// Job `email.backfill` (BACKEND_PLAN §7.8.1, §9): the first scan of a new connection over the last 13 months, so
// yearly renewals are found. Singleton per connection; resumable by page token.
//
// Resumable: after EVERY page the messages, the page token to continue from and (on the page that has it) the
// sync cursor are written in one transaction. An interruption (a provider outage, a crash, a deploy) loses at
// most the page in flight; the next run starts from `backfill_cursor`. A message seen twice is skipped by the unique
// index, so a repeated page, or a message that also arrives through discover, is stored once.
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  accessFor,
  failOrRethrow,
  householdWatchedDomains,
  ingestMessages,
  loadConnection,
  monthsBack,
  providerFor,
  type EmailJobDeps,
} from "../discover/connection";

export const EMAIL_BACKFILL_QUEUE = "email.backfill";
export const EmailBackfillJob = z.object({ householdId: z.uuid(), connectionId: z.uuid() });
export type EmailBackfillJob = z.infer<typeof EmailBackfillJob>;
export const EMAIL_BACKFILL_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 8,
  retryDelay: 30,
  retryBackoff: true,
} as const;
export const emailBackfillSingletonKey = (j: EmailBackfillJob) => `${EMAIL_BACKFILL_QUEUE}:${j.connectionId}`;

/** Pages per run. A longer backfill is continued by the next sweep (every minute), from the saved token. */
export const BACKFILL_PAGES_PER_RUN = 20;

export type BackfillOutcome =
  | { outcome: "skipped"; reason: "not_active" | "already_done" | "no_provider" | "no_token" | "gone" }
  | { outcome: "auth_failed" | "provider_failed" }
  | { outcome: "progress"; pages: number; stored: number }
  | { outcome: "done"; pages: number; stored: number };

export async function handleEmailBackfill(deps: EmailJobDeps, data: unknown): Promise<BackfillOutcome> {
  const job = EmailBackfillJob.parse(data);
  const { householdId } = job;
  const conn = await deps.db.withJobTx(householdId, (tx) =>
    loadConnection(tx, householdId, job.connectionId),
  );
  if (!conn) return { outcome: "skipped", reason: "gone" };
  if (conn.status !== "active") return { outcome: "skipped", reason: "not_active" };
  if (conn.backfillStatus === "done") return { outcome: "skipped", reason: "already_done" };
  const provider = providerFor(deps, conn);
  if (!provider) return { outcome: "skipped", reason: "no_provider" };
  if (!conn.sealed) return { outcome: "skipped", reason: "no_token" };

  const nowIso = deps.now();
  const { sinceIso, days } = monthsBack(nowIso, conn.backfillMonths);
  let pageToken = conn.backfillCursor;
  let pages = 0;
  let stored = 0;
  try {
    const { accessToken } = await accessFor(deps, conn, provider);
    const watched = await deps.db.withJobTx(householdId, (tx) => householdWatchedDomains(tx, householdId));
    for (; pages < BACKFILL_PAGES_PER_RUN;) {
      const page = await provider.backfillPage(accessToken, {
        sinceIso,
        lookbackDays: days,
        pageToken,
        watchedDomains: watched,
      });
      pages++;
      const last = page.nextPageToken === null;
      stored += await deps.db.withJobTx(householdId, async (tx) => {
        const n = await ingestMessages(tx, conn, page.messages, watched, "backfill");
        await tx.execute(sql`update email_connections set
            backfill_status = ${last ? "done" : "running"},
            backfill_cursor = ${page.nextPageToken},
            sync_cursor = ${page.cursor === null ? sql`sync_cursor` : sql`coalesce(sync_cursor, ${page.cursor})`},
            last_synced_at = case when ${last} then ${nowIso}::timestamptz else last_synced_at end
          where id = ${conn.id} and household_id = ${householdId} and status = 'active'`);
        return n;
      });
      if (last) return { outcome: "done", pages, stored };
      pageToken = page.nextPageToken;
    }
    return { outcome: "progress", pages, stored };
  } catch (err) {
    // Everything up to the failed page is saved; a retry continues from there.
    return { outcome: await failOrRethrow(deps, conn, err) };
  }
}
