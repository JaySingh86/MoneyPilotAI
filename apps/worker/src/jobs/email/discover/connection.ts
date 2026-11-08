// Shared by the email connector jobs (WP-21): the connection row as the worker sees it (the only role that can read
// the ciphertext columns), opening the token and getting an access token, writing message metadata, and telling
// the owner. Always called inside `withJobTx` unless noted: RLS scopes every statement to one household.
//
// Hard rules: no body, no subject and no address is stored or logged here; an error from a provider never
// reaches a log with more than its kind (ProviderError messages are fixed text).
import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { sql } from "drizzle-orm";
import { insertNotification, type Tx, type WorkerDb } from "@mp/db";
import { openToken, sealToken, type KeyProvider, type SealedToken } from "@mp/crypto";
import { parseFromAddress, prefilter } from "@mp/email/prefilter";
import {
  ProviderError,
  type MailProvider,
  type MailProviderId,
  type MessageMeta,
  type Providers,
} from "@mp/email/providers";
import type { Logger } from "@mp/observability";
import type { JobSender } from "../../plan/recompute";

export interface EmailJobDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
  providers: Providers;
  keys: KeyProvider;
  /** Secret behind the Graph `clientState` (shared with the API). */
  graphStateSecret: Uint8Array;
}

export interface SweepDeps {
  db: WorkerDb;
  /** Polling interval in minutes for connections without a push (default 15). */
  pollMinutes?: number;
  sender: JobSender;
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export type ConnectionStatus = "active" | "paused" | "error" | "revoked";
export type LastError =
  | "auth_expired"
  | "provider_error"
  | "rate_limited"
  | "watch_failed"
  | "watch_expiring"
  | "revoked_by_provider";

export interface Connection {
  id: string;
  householdId: string;
  userId: string;
  provider: MailProviderId;
  status: ConnectionStatus;
  sealed: SealedToken | null;
  syncCursor: string | null;
  watchRef: string | null;
  watchExpiresAt: string | null;
  pushReceivedAt: string | null;
  lastSyncedAt: string | null;
  lastError: LastError | null;
  backfillMonths: number;
  backfillStatus: "pending" | "running" | "done" | "failed";
  backfillCursor: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as Date).toISOString();

function toConnection(r: Row): Connection {
  const ciphertext = r.token_ciphertext as Buffer | null;
  const dek = r.token_dek_wrapped as Buffer | null;
  const keyId = strOrNull(r.token_key_id);
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    userId: str(r.user_id),
    provider: r.provider as MailProviderId,
    status: r.status as ConnectionStatus,
    sealed: ciphertext && dek && keyId ? { ciphertext, dekWrapped: dek, keyId } : null,
    syncCursor: strOrNull(r.sync_cursor),
    watchRef: strOrNull(r.watch_ref),
    watchExpiresAt: iso(r.watch_expires_at),
    // Kept as text: a JS Date would drop the microseconds and the "seen" comparison would never match.
    pushReceivedAt: strOrNull(r.push_received_at_text),
    lastSyncedAt: iso(r.last_synced_at),
    lastError: strOrNull(r.last_error) as LastError | null,
    backfillMonths: Number(r.backfill_months),
    backfillStatus: r.backfill_status as Connection["backfillStatus"],
    backfillCursor: strOrNull(r.backfill_cursor),
  };
}

const SELECT = sql`id, household_id, user_id, provider, status, token_ciphertext, token_dek_wrapped, token_key_id,
  sync_cursor, watch_ref, watch_expires_at, push_received_at::text as push_received_at_text, last_synced_at, last_error, backfill_months,
  backfill_status, backfill_cursor`;

export async function loadConnection(tx: Tx, householdId: string, id: string): Promise<Connection | null> {
  const res = await tx.execute<Row>(
    sql`select ${SELECT} from email_connections where id = ${id} and household_id = ${householdId}`,
  );
  return res.rows[0] ? toConnection(res.rows[0]) : null;
}

export async function listConnections(tx: Tx, householdId: string): Promise<Connection[]> {
  const res = await tx.execute<Row>(
    sql`select ${SELECT} from email_connections where household_id = ${householdId} and
      (status in ('active') or (status = 'revoked' and token_ciphertext is not null)) order by created_at, id`,
  );
  return res.rows.map(toConnection);
}

/** The provider client for a connection, or null when this worker has no settings for it. */
export function providerFor(deps: EmailJobDeps, c: Pick<Connection, "provider">): MailProvider | null {
  return deps.providers[c.provider] ?? null;
}

export async function householdWatchedDomains(tx: Tx, householdId: string): Promise<string[]> {
  const res = await tx.execute<{
    d: string;
  }>(sql`select distinct lower(provider_domain) as d from recurring_items
    where household_id = ${householdId} and provider_domain is not null and deleted_at is null`);
  return res.rows.map((r) => r.d).filter(Boolean);
}

// ===== Tokens =====

export interface Access {
  accessToken: string;
  /** The refresh token, for revocation. Held in memory only for the duration of the job. */
  refreshToken: string;
}

/**
 * Opens the sealed refresh token and exchanges it for an access token. When the provider rotates the refresh token
 * (Microsoft does), the new one is sealed and stored first, so a crash cannot lose the only valid token.
 * Throws ProviderError (kind `auth_revoked` when the grant is gone).
 */
export async function accessFor(deps: EmailJobDeps, c: Connection, provider: MailProvider): Promise<Access> {
  if (!c.sealed) throw new Error("The connection has no token.");
  const refreshToken = await openToken(deps.keys, c.sealed, { connectionId: c.id });
  const refreshed = await provider.refresh(refreshToken);
  if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
    const sealed = await sealToken(deps.keys, refreshed.refreshToken, { connectionId: c.id });
    await deps.db.withJobTx(c.householdId, (tx) =>
      tx.execute(sql`update email_connections set token_ciphertext = ${Buffer.from(sealed.ciphertext)},
          token_dek_wrapped = ${Buffer.from(sealed.dekWrapped)}, token_key_id = ${sealed.keyId}
        where id = ${c.id} and household_id = ${c.householdId} and status <> 'revoked'`),
    );
    return { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
  }
  return { accessToken: refreshed.accessToken, refreshToken };
}

// ===== Status =====

export async function markError(
  tx: Tx,
  c: Connection,
  error: LastError,
  status: "error" | null = "error",
): Promise<void> {
  await tx.execute(sql`update email_connections set last_error = ${error},
      status = ${status ?? c.status}
    where id = ${c.id} and household_id = ${c.householdId} and status <> 'revoked'`);
}

export async function notifyOwner(
  tx: Tx,
  c: Connection,
  input: { dedupeKey: string; title: string; body: string },
): Promise<void> {
  await insertNotification(tx, {
    householdId: c.householdId,
    userId: c.userId,
    kind: "system",
    dedupeKey: input.dedupeKey,
    title: input.title,
    body: input.body,
    deepLink: "/imports",
  });
}

/** The owner needs to reconnect: the provider no longer accepts the grant. Idempotent (dedupe key). */
export async function failAuth(tx: Tx, c: Connection): Promise<void> {
  await markError(tx, c, "auth_expired");
  await notifyOwner(tx, c, {
    dedupeKey: `email.auth_expired:${c.id}`,
    title: `Reconnect your ${c.provider === "gmail" ? "Gmail" : "Outlook"} mailbox`,
    body: "We can no longer read new bills from this mailbox. Nothing was changed. Reconnect it to keep it up to date.",
  });
}

export async function audit(
  tx: Tx,
  c: Pick<Connection, "id" | "householdId">,
  action: string,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata)
    values (${c.householdId}, null, 'system', ${action}, 'email_connection', ${c.id}, ${JSON.stringify(metadata)}::jsonb)`);
}

// ===== Messages =====

/**
 * Stores what we know about each message: its provider id, when it arrived, the sender's domain and the prefilter's
 * verdict (BACKEND_PLAN §7.8.2: metadata only). The subject is used in memory for the prefilter and never stored; the
 * pipeline stores it only when an item was extracted. A message seen before (same connection, same provider id) is
 * skipped, which makes discovery and backfill idempotent. Returns how many rows were new.
 */
export async function ingestMessages(
  tx: Tx,
  c: Connection,
  messages: readonly MessageMeta[],
  watchedDomains: readonly string[],
): Promise<number> {
  if (messages.length === 0) return 0;
  // Only a live connection stores anything. FOR NO KEY UPDATE makes a pause or a disconnect that is committing wait for this
  // write, or this write wait for it, so nothing is stored for a mailbox the owner just stopped.
  const live = await tx.execute(sql`select 1 from email_connections
    where id = ${c.id} and household_id = ${c.householdId} and status = 'active' for no key update`);
  if (live.rows.length === 0) return 0;
  const seen = new Set<string>();
  const rows = [];
  for (const m of messages) {
    if (seen.has(m.providerMessageId)) continue;
    seen.add(m.providerMessageId);
    const verdict = prefilter(
      { from: m.from, subject: m.subject, labels: m.labels, listId: m.listId },
      { watchedDomains, ignoredDomains: [] },
    );
    rows.push(sql`(${randomUUID()}, ${c.householdId}, ${c.id}, ${c.provider}, ${m.providerMessageId.slice(0, 512)},
      ${m.receivedAt}::timestamptz, ${parseFromAddress(m.from)?.domain ?? "unknown.invalid"},
      ${verdict.decision === "out" ? "prefiltered_out" : "discovered"})`);
  }
  const res = await tx.execute(sql`insert into email_messages
      (id, household_id, connection_id, channel, provider_message_id, received_at, from_domain, stage)
    values ${sql.join(rows, sql`, `)}
    on conflict do nothing`);
  return res.rowCount ?? 0;
}

export async function recordSync(
  tx: Tx,
  c: Connection,
  update: { cursor: string | null; keepExistingCursor?: boolean; pushSeenAt: string | null; now: string },
): Promise<void> {
  const cursor =
    update.cursor === null
      ? sql`sync_cursor`
      : update.keepExistingCursor
        ? sql`coalesce(sync_cursor, ${update.cursor})`
        : sql`${update.cursor}`;
  await tx.execute(sql`update email_connections set sync_cursor = ${cursor}, last_synced_at = ${update.now}::timestamptz,
      last_error = case when last_error in ('rate_limited','provider_error') then null else last_error end,
      push_received_at = case when ${update.pushSeenAt}::timestamptz is not null and push_received_at <= ${update.pushSeenAt}::timestamptz
        then null else push_received_at end
    where id = ${c.id} and household_id = ${c.householdId} and status in ('active')`);
}

// ===== Time windows (instants, not calendar dates) =====

/** The start of a look-back window of `months` calendar months in UTC, and its length in whole days. */
export function monthsBack(nowIso: string, months: number): { sinceIso: string; days: number } {
  const now = Temporal.Instant.from(nowIso).toZonedDateTimeISO("UTC");
  const since = now.subtract({ months });
  return {
    sinceIso: since.toInstant().toString({ smallestUnit: "second" }),
    days: Math.max(1, Math.floor(now.epochMilliseconds / 86_400_000 - since.epochMilliseconds / 86_400_000)),
  };
}

export function daysBack(nowIso: string, days: number): string {
  return Temporal.Instant.from(nowIso)
    .subtract({ hours: days * 24 })
    .toString({ smallestUnit: "second" });
}

// ===== Failures =====

/**
 * What to do with a provider error that retrying will not fix. `auth_revoked`: the grant is gone, the owner must
 * reconnect. `permanent` (the provider refused access, a scope or permission is missing): fail fast, mark the
 * connection `error` and tell the owner, instead of retrying eight times. Anything else (rate limits, outages) is
 * rethrown for pg-boss to retry with backoff, and nothing was written. Returns the outcome label, or rethrows.
 */
export async function failOrRethrow(
  deps: Pick<EmailJobDeps, "db">,
  c: Connection,
  err: unknown,
): Promise<"auth_failed" | "provider_failed"> {
  if (err instanceof ProviderError && err.kind === "auth_revoked") {
    await deps.db.withJobTx(c.householdId, (tx) => failAuth(tx, c));
    return "auth_failed";
  }
  if (err instanceof ProviderError && err.kind === "permanent") {
    await deps.db.withJobTx(c.householdId, async (tx) => {
      await markError(tx, c, "provider_error");
      await notifyOwner(tx, c, {
        dedupeKey: `email.provider_error:${c.id}`,
        title: `We could not read your ${c.provider === "gmail" ? "Gmail" : "Outlook"} mailbox`,
        body: "The provider refused access. Nothing was changed. Reconnect it from Email & imports, and allow read access to your mail.",
      });
    });
    return "provider_failed";
  }
  throw err;
}
