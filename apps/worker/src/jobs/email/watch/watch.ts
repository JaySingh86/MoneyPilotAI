// Job `email.watch` (BACKEND_PLAN §7.8.1, §9): starts the Gmail watch or the Graph subscription for a connection and
// renews it. Gmail watches expire after 7 days, Outlook message subscriptions after about 3, so the sweep renews
// every active connection DAILY. When a renewal still fails after the retries the connection goes to `error` and the
// owner is told; a watch within 24 hours of expiring raises an alert (`watchExpiryAlert`).
//
// Idempotent: starting or renewing twice leaves one live watch and the same state. The Graph `clientState` is derived
// from the connection id and a server secret, so it never has to be stored.
import { z } from "zod";
import { sql } from "drizzle-orm";
import { graphClientState, ProviderError } from "@mp/email/providers";
import type { Tx } from "@mp/db";
import {
  accessFor,
  failOrRethrow,
  loadConnection,
  markError,
  notifyOwner,
  providerFor,
  type Connection,
  type EmailJobDeps,
} from "../discover/connection";

/** BACKEND_PLAN §9 names it `email.watch.renew`; the same job also starts the watch the first time. */
export const EMAIL_WATCH_QUEUE = "email.watch.renew";
export const EmailWatchJob = z.object({ householdId: z.uuid(), connectionId: z.uuid() });
export type EmailWatchJob = z.infer<typeof EmailWatchJob>;
/** BACKEND_PLAN §9: renewal is retried 5 times, then the connection is `error` and the owner is told. */
export const EMAIL_WATCH_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
} as const;
export const emailWatchSingletonKey = (j: EmailWatchJob) => `${EMAIL_WATCH_QUEUE}:${j.connectionId}`;

/** A watch that expires within this many hours raises an alert. */
export const WATCH_ALERT_HOURS = 24;
const HOUR_MS = 3_600_000;

export type WatchOutcome =
  | { outcome: "skipped"; reason: "not_active" | "no_provider" | "no_token" | "gone" }
  | { outcome: "auth_failed" | "provider_failed" }
  | { outcome: "started" | "renewed"; expiresAt: string };

export async function handleEmailWatch(
  deps: EmailJobDeps,
  data: unknown,
  options: { lastAttempt?: boolean } = {},
): Promise<WatchOutcome> {
  const job = EmailWatchJob.parse(data);
  const { householdId } = job;
  const conn = await deps.db.withJobTx(householdId, (tx) =>
    loadConnection(tx, householdId, job.connectionId),
  );
  if (!conn) return { outcome: "skipped", reason: "gone" };
  if (conn.status !== "active") return { outcome: "skipped", reason: "not_active" };
  const provider = providerFor(deps, conn);
  if (!provider) return { outcome: "skipped", reason: "no_provider" };
  if (!conn.sealed) return { outcome: "skipped", reason: "no_token" };

  try {
    const { accessToken } = await accessFor(deps, conn, provider);
    const clientState = graphClientState(deps.graphStateSecret, conn.id);
    const starting = conn.watchExpiresAt === null;
    let ref: string | null;
    let expiresAt: string;
    let cursor: string | null = null;
    if (starting) {
      const w = await provider.startWatch(accessToken, { clientState });
      ({ ref, expiresAt, cursor } = w);
    } else {
      ({ ref, expiresAt } = await provider.renewWatch(accessToken, { ref: conn.watchRef, clientState }));
    }
    await deps.db.withJobTx(householdId, (tx) =>
      tx.execute(sql`update email_connections set watch_ref = ${ref}, watch_expires_at = ${expiresAt}::timestamptz,
          -- Gmail: the watch's history position is only used when the backfill has not set one yet.
          sync_cursor = ${cursor === null ? sql`sync_cursor` : sql`coalesce(sync_cursor, ${cursor})`},
          last_error = case when last_error in ('watch_failed','watch_expiring') then null else last_error end
        where id = ${conn.id} and household_id = ${householdId} and status = 'active'`),
    );
    return { outcome: starting ? "started" : "renewed", expiresAt };
  } catch (err) {
    if (err instanceof ProviderError && (err.kind === "auth_revoked" || err.kind === "permanent")) {
      return { outcome: await failOrRethrow(deps, conn, err) };
    }
    if (options.lastAttempt) await giveUp(deps, conn);
    throw err;
  }
}

/** The last retry failed: say so on the connection and tell its owner. */
async function giveUp(deps: EmailJobDeps, conn: Connection): Promise<void> {
  await deps.db.withJobTx(conn.householdId, async (tx) => {
    await markError(tx, conn, "watch_failed");
    await notifyOwner(tx, conn, {
      dedupeKey: `email.watch_failed:${conn.id}:${deps.now().slice(0, 10)}`,
      title: `We stopped checking your ${conn.provider === "gmail" ? "Gmail" : "Outlook"} mailbox`,
      body: "We could not keep the connection running. Nothing was changed. Open Email & imports to reconnect it.",
    });
  });
  deps.log.error({ alert: "email_watch_failed", connectionId: conn.id }, "email watch could not be renewed");
}

export interface ExpiryAlert {
  connectionId: string;
  householdId: string;
}

/**
 * Connections whose watch ends within 24 hours although the daily renewal should have kept it far from that: the
 * renewal is failing. Each is flagged `watch_expiring` once (until a renewal succeeds), the owner is told and an alert
 * line is logged for paging (BACKEND_PLAN §9: dead-letter and expiry alerts).
 */
export async function watchExpiryAlert(
  tx: Tx,
  deps: Pick<EmailJobDeps, "now" | "log">,
  householdId: string,
  connections: readonly Connection[],
): Promise<ExpiryAlert[]> {
  const horizon = Date.parse(deps.now()) + WATCH_ALERT_HOURS * HOUR_MS;
  const alerts: ExpiryAlert[] = [];
  for (const c of connections) {
    if (c.status !== "active" || c.watchExpiresAt === null) continue;
    if (Date.parse(c.watchExpiresAt) > horizon || c.lastError === "watch_expiring") continue;
    await markError(tx, c, "watch_expiring", null);
    await notifyOwner(tx, c, {
      dedupeKey: `email.watch_expiring:${c.id}:${deps.now().slice(0, 10)}`,
      title: `Your ${c.provider === "gmail" ? "Gmail" : "Outlook"} connection may stop soon`,
      body: "We are having trouble keeping this mailbox connected. If it keeps happening, you will be asked to reconnect.",
    });
    deps.log.error(
      { alert: "email_watch_expiring", connectionId: c.id },
      "email watch expires within 24 hours",
    );
    alerts.push({ connectionId: c.id, householdId });
  }
  return alerts;
}
