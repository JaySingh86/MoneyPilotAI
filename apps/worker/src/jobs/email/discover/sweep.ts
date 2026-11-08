// Jobs `email.sweep` and `email.watch.sweep` (BACKEND_PLAN §9). The API cannot enqueue (no queue role yet, Q-105), so it
// leaves marks in the database and this sweep, every minute, turns them into jobs:
//   - a disconnected mailbox that still holds a token        -> email.revoke
//   - a connection whose first scan is not finished          -> email.backfill
//   - a connection with no watch yet                         -> email.watch (start)
//   - a verified push, or no check in 15 minutes (fallback)  -> email.discover
// It also raises the watch-expiry alert and prunes expired OAuth states. `email.watch.sweep` runs daily and renews
// every active connection's watch or subscription. Every job has a singleton key per connection, so a sweep that
// runs twice, or a push on top of the poll, queues one job.
import { sql } from "drizzle-orm";
import { EMAIL_BACKFILL_QUEUE, emailBackfillSingletonKey } from "../backfill/backfill";
import { EMAIL_REVOKE_QUEUE, emailRevokeSingletonKey } from "../watch/revoke";
import { EMAIL_WATCH_QUEUE, emailWatchSingletonKey, watchExpiryAlert } from "../watch/watch";
import { EMAIL_DISCOVER_QUEUE, emailDiscoverSingletonKey } from "./discover";
import { listConnections, type Connection, type SweepDeps } from "./connection";

export const EMAIL_SWEEP_QUEUE = "email.sweep";
/** Every minute (the smallest pg-boss cron step). */
export const EMAIL_SWEEP_CRON = "* * * * *";
export const EMAIL_WATCH_SWEEP_QUEUE = "email.watch.sweep";
/** 05:00 UTC every day. */
export const EMAIL_WATCH_SWEEP_CRON = "0 5 * * *";
/** BACKEND_PLAN §9: a fallback poll every 15 minutes, in case a push was lost. */
export const POLL_MINUTES = 15;

/** `EMAIL_POLL_MINUTES` (1 to 1440; default 15): how often each connection is synced when no push arrives. */
export function pollMinutesFrom(env: { EMAIL_POLL_MINUTES?: string | undefined }): number {
  const n = Number(env.EMAIL_POLL_MINUTES);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : POLL_MINUTES;
}

export type EmailQueue =
  | typeof EMAIL_REVOKE_QUEUE
  | typeof EMAIL_BACKFILL_QUEUE
  | typeof EMAIL_WATCH_QUEUE
  | typeof EMAIL_DISCOVER_QUEUE;

/** What one connection needs right now. Pure: the table in sweep.test.ts. */
export function jobsFor(c: Connection, nowMs: number, pollMinutes: number = POLL_MINUTES): EmailQueue[] {
  if (c.status === "revoked") return c.sealed ? [EMAIL_REVOKE_QUEUE] : [];
  if (c.status !== "active" || !c.sealed) return [];
  const out: EmailQueue[] = [];
  if (c.backfillStatus === "pending" || c.backfillStatus === "running") out.push(EMAIL_BACKFILL_QUEUE);
  if (c.watchExpiresAt === null) out.push(EMAIL_WATCH_QUEUE);
  if (c.syncCursor !== null) {
    const stale = c.lastSyncedAt === null || nowMs - Date.parse(c.lastSyncedAt) >= pollMinutes * 60_000;
    if (c.pushReceivedAt !== null || stale) out.push(EMAIL_DISCOVER_QUEUE);
  }
  return out;
}

const KEYS: Record<EmailQueue, (j: { householdId: string; connectionId: string }) => string> = {
  [EMAIL_REVOKE_QUEUE]: emailRevokeSingletonKey,
  [EMAIL_BACKFILL_QUEUE]: emailBackfillSingletonKey,
  [EMAIL_WATCH_QUEUE]: emailWatchSingletonKey,
  [EMAIL_DISCOVER_QUEUE]: emailDiscoverSingletonKey,
};

export async function handleEmailSweep(
  deps: SweepDeps,
): Promise<{ households: number; connections: number; enqueued: number; alerts: number }> {
  const ids = await deps.db.listHouseholdIds();
  const nowMs = Date.parse(deps.now());
  let connections = 0;
  let enqueued = 0;
  let alerts = 0;
  let pruned = false;
  for (const householdId of ids) {
    const found = await deps.db.withJobTx(householdId, async (tx) => {
      if (!pruned) {
        // The policy lets any household's job delete expired states, and only expired ones.
        await tx.execute(sql`delete from email_oauth_states where expires_at < now()`);
        pruned = true;
      }
      const list = await listConnections(tx, householdId);
      const raised = await watchExpiryAlert(tx, deps, householdId, list);
      return { list, raised };
    });
    alerts += found.raised.length;
    for (const c of found.list) {
      connections++;
      const queues = jobsFor(c, nowMs, deps.pollMinutes);
      // A watch that is about to lapse is renewed now, not at the next daily run.
      if (found.raised.some((a) => a.connectionId === c.id) && !queues.includes(EMAIL_WATCH_QUEUE)) {
        queues.push(EMAIL_WATCH_QUEUE);
      }
      for (const queue of queues) {
        const job = { householdId, connectionId: c.id };
        if ((await deps.sender.send(queue, job, { singletonKey: KEYS[queue](job) })) !== null) enqueued++;
      }
    }
  }
  return { households: ids.length, connections, enqueued, alerts };
}

/** Daily: renew the watch or subscription of every active connection. */
export async function handleEmailWatchSweep(
  deps: SweepDeps,
): Promise<{ households: number; enqueued: number }> {
  const ids = await deps.db.listHouseholdIds();
  let enqueued = 0;
  for (const householdId of ids) {
    const list = await deps.db.withJobTx(householdId, (tx) => listConnections(tx, householdId));
    for (const c of list) {
      if (c.status !== "active" || !c.sealed) continue;
      const job = { householdId, connectionId: c.id };
      if (
        (await deps.sender.send(EMAIL_WATCH_QUEUE, job, { singletonKey: emailWatchSingletonKey(job) })) !==
        null
      ) {
        enqueued++;
      }
    }
  }
  return { households: ids.length, enqueued };
}
