// Job `email.discover` (BACKEND_PLAN §7.8.2, §9): finds new mail for one connection through Gmail history or the
// Graph delta, from the stored cursor, and records message METADATA (provider id, arrival time, sender domain, the
// prefilter's verdict). Triggered by a verified push (the API marks `push_received_at`) and by a 15-minute fallback
// poll. Singleton per connection; retried 8x with backoff for provider limits.
//
// Idempotent: the provider calls happen first, then one short transaction writes the messages and moves the cursor
// together. A message already stored (same connection, same provider id) is skipped by the unique index, so a
// duplicate push, an overlapping run or a retry adds nothing. If the cursor is too old the job falls back to a
// bounded listing of the last 30 days.
import { z } from "zod";
import { ProviderError, type BackfillPage } from "@mp/email/providers";
import {
  accessFor,
  daysBack,
  failOrRethrow,
  householdWatchedDomains,
  ingestMessages,
  loadConnection,
  providerFor,
  recordSync,
  type Connection,
  type EmailJobDeps,
} from "./connection";

export const EMAIL_DISCOVER_QUEUE = "email.discover";
export const EmailDiscoverJob = z.object({ householdId: z.uuid(), connectionId: z.uuid() });
export type EmailDiscoverJob = z.infer<typeof EmailDiscoverJob>;
/** BACKEND_PLAN §9: 8 attempts with exponential backoff; `short` keeps one queued job per connection. */
export const EMAIL_DISCOVER_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 8,
  retryDelay: 15,
  retryBackoff: true,
} as const;
export const emailDiscoverSingletonKey = (j: EmailDiscoverJob) => `${EMAIL_DISCOVER_QUEUE}:${j.connectionId}`;

/** How far back, and how many pages, the fallback listing covers when a cursor is too old. */
export const FALLBACK_DAYS = 30;
export const FALLBACK_MAX_PAGES = 5;

export type DiscoverOutcome =
  | { outcome: "skipped"; reason: "not_active" | "no_cursor" | "no_provider" | "no_token" | "gone" }
  | { outcome: "auth_failed" | "provider_failed" }
  | { outcome: "done"; stored: number; seen: number; fallback: boolean };

export async function handleEmailDiscover(deps: EmailJobDeps, data: unknown): Promise<DiscoverOutcome> {
  const job = EmailDiscoverJob.parse(data);
  const { householdId } = job;
  const conn = await deps.db.withJobTx(householdId, (tx) =>
    loadConnection(tx, householdId, job.connectionId),
  );
  if (!conn) return { outcome: "skipped", reason: "gone" };
  if (conn.status !== "active") return { outcome: "skipped", reason: "not_active" };
  // Before the first backfill page there is no position to continue from; the backfill job sets it.
  if (conn.syncCursor === null) return { outcome: "skipped", reason: "no_cursor" };
  const provider = providerFor(deps, conn);
  if (!provider) return { outcome: "skipped", reason: "no_provider" };
  if (!conn.sealed) return { outcome: "skipped", reason: "no_token" };

  const pushSeenAt = conn.pushReceivedAt;
  const nowIso = deps.now();
  try {
    const { accessToken } = await accessFor(deps, conn, provider);
    let messages;
    let cursor: string;
    let fallback = false;
    try {
      const page = await provider.listChanges(accessToken, conn.syncCursor);
      messages = page.messages;
      cursor = page.cursor;
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== "cursor_expired") throw err;
      fallback = true;
      const out = await boundedFallback(deps, conn, accessToken, nowIso);
      messages = out.messages;
      cursor = out.cursor;
    }
    const stored = await deps.db.withJobTx(householdId, async (tx) => {
      const watched = await householdWatchedDomains(tx, householdId);
      const n = await ingestMessages(tx, conn, messages, watched);
      await recordSync(tx, conn, { cursor, pushSeenAt, now: nowIso });
      return n;
    });
    return { outcome: "done", stored, seen: messages.length, fallback };
  } catch (err) {
    // Rate limits and outages are rethrown for pg-boss to retry with backoff; nothing was written.
    return { outcome: await failOrRethrow(deps, conn, err) };
  }
}

/** The last 30 days, at most 5 pages, and the cursor to continue from afterwards. */
async function boundedFallback(
  deps: EmailJobDeps,
  conn: Connection,
  accessToken: string,
  nowIso: string,
): Promise<{ messages: BackfillPage["messages"]; cursor: string }> {
  const provider = providerFor(deps, conn);
  if (!provider) throw new Error("No provider.");
  const sinceIso = daysBack(nowIso, FALLBACK_DAYS);
  const messages: BackfillPage["messages"] = [];
  let cursor: string | null = null;
  let pageToken: string | null = null;
  for (let i = 0; i < FALLBACK_MAX_PAGES; i++) {
    const page: BackfillPage = await provider.backfillPage(accessToken, {
      sinceIso,
      lookbackDays: FALLBACK_DAYS,
      pageToken,
      watchedDomains: [],
    });
    messages.push(...page.messages);
    cursor = page.cursor ?? cursor;
    pageToken = page.nextPageToken;
    if (pageToken === null) break;
  }
  if (cursor === null) throw new ProviderError("transient", "The fallback listing gave no cursor.");
  return { messages, cursor };
}
