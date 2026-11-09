// SQL for the processing pipeline (module layout: SQL lives in repos). Always called inside `withJobTx`: RLS scopes every
// statement to one household. No statement here reads or writes an email body, and none returns an amount to a log.
import { sql } from "drizzle-orm";
import { itemAmount, type Cents } from "@mp/engine";
import { loadEngineInput, type Tx } from "@mp/db";
import { UNDO_WINDOW_DAYS, type RenewalDetails } from "@mp/contracts";
import type { MatchableItem } from "@mp/email";
import type { ItemContext } from "./analyze";

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const centsOrNull = (v: unknown): Cents | null => (v === null || v === undefined ? null : Number(v));

// ===== Messages =====
export interface PendingMessage {
  id: string;
  householdId: string;
  connectionId: string | null;
  providerMessageId: string;
  /** UTC instant, ISO 8601. */
  receivedAtIso: string;
  fromDomain: string;
  intake: "discover" | "backfill";
  aiBatchId: string | null;
  stage: string;
  /** How often it was released from a batch unprocessed. */
  releases: number;
}

const MESSAGE_COLUMNS = sql`id, household_id, connection_id, provider_message_id,
  to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as received_at, from_domain, intake,
  ai_batch_id, stage, extract_releases`;

function toMessage(r: Row): PendingMessage {
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    connectionId: strOrNull(r.connection_id),
    providerMessageId: str(r.provider_message_id),
    receivedAtIso: str(r.received_at),
    fromDomain: str(r.from_domain),
    intake: r.intake as PendingMessage["intake"],
    aiBatchId: strOrNull(r.ai_batch_id),
    stage: str(r.stage),
    releases: Number(r.extract_releases ?? 0),
  };
}

/** Messages of a connection that discovery found and nobody has processed, oldest first. */
export async function listPending(
  tx: Tx,
  householdId: string,
  connectionId: string,
  intake: "discover" | "backfill",
  limit: number,
  /** Backfill takes the newest first, so a cap keeps the mail that matters most. */
  newestFirst = false,
): Promise<PendingMessage[]> {
  const res = await tx.execute<Row>(sql`select ${MESSAGE_COLUMNS} from email_messages
    where household_id = ${householdId} and connection_id = ${connectionId} and stage = 'discovered'
      and intake = ${intake} and ai_batch_id is null
    order by ${newestFirst ? sql`received_at desc` : sql`received_at`}, id limit ${limit}`);
  return res.rows.map(toMessage);
}

/** Messages waiting in a Batch API batch. */
export async function listInBatch(tx: Tx, householdId: string, batchId: string): Promise<PendingMessage[]> {
  const res = await tx.execute<Row>(sql`select ${MESSAGE_COLUMNS} from email_messages
    where household_id = ${householdId} and ai_batch_id = ${batchId} and stage = 'discovered'
    order by received_at, id`);
  return res.rows.map(toMessage);
}

/** The message row, locked, so a repeat of the same job waits and then finds the stage already moved. */
export async function lockMessage(tx: Tx, householdId: string, id: string): Promise<PendingMessage | null> {
  const res = await tx.execute<Row>(sql`select ${MESSAGE_COLUMNS} from email_messages
    where id = ${id} and household_id = ${householdId} for update`);
  return res.rows[0] ? toMessage(res.rows[0]) : null;
}

export type FinalStage = "prefiltered_out" | "irrelevant" | "extracted" | "failed";

/**
 * Moves a message out of `discovered`. The subject is stored only when an item was extracted from the message
 * (BACKEND_PLAN §7.8.2 `email.cleanup`), and it is the redacted one.
 */
export async function finishMessage(
  tx: Tx,
  householdId: string,
  id: string,
  update: { stage: FinalStage; truncated: boolean; subject: string | null; nowIso: string },
): Promise<void> {
  await tx.execute(sql`update email_messages set stage = ${update.stage}, truncated = ${update.truncated},
      subject = ${update.stage === "extracted" ? update.subject : null}, processed_at = ${update.nowIso}::timestamptz,
      ai_batch_id = null
    where id = ${id} and household_id = ${householdId} and stage = 'discovered'`);
}

/** A batch id is reserved BEFORE the batch is submitted, so a failure to record the real id cannot resubmit every minute. */
export const RESERVATION_PREFIX = "pending:";
/** A reservation older than this was left by a crash; its messages go back to waiting (one more submit, never a loop). */
export const RESERVATION_MAX_AGE_MINUTES = 30;

/** Reserves messages for a batch about to be submitted (they leave the "waiting" set at once). */
export async function reserveForBatch(
  tx: Tx,
  householdId: string,
  ids: readonly string[],
  token: string,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`update email_messages set ai_batch_id = ${token}
    where household_id = ${householdId} and stage = 'discovered' and ai_batch_id is null
      and id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`);
}

export async function confirmBatch(
  tx: Tx,
  householdId: string,
  token: string,
  batchId: string,
): Promise<void> {
  await tx.execute(sql`update email_messages set ai_batch_id = ${batchId}
    where household_id = ${householdId} and stage = 'discovered' and ai_batch_id = ${token}`);
}

/** Puts a reservation back to waiting. */
export async function releaseBatch(tx: Tx, householdId: string, ref: string): Promise<void> {
  await tx.execute(sql`update email_messages set ai_batch_id = null
    where household_id = ${householdId} and stage = 'discovered' and ai_batch_id = ${ref}`);
}

export async function releaseStaleReservations(tx: Tx, householdId: string, nowIso: string): Promise<number> {
  const res = await tx.execute(sql`update email_messages set ai_batch_id = null
    where household_id = ${householdId} and stage = 'discovered' and ai_batch_id like ${RESERVATION_PREFIX + "%"}
      and coalesce(extract_charged_at, created_at) < ${nowIso}::timestamptz - make_interval(mins => ${RESERVATION_MAX_AGE_MINUTES})`);
  return res.rowCount ?? 0;
}

/** Puts one message back to waiting (it was in a batch whose result could not be used today). */
export async function releaseMessage(tx: Tx, householdId: string, id: string): Promise<void> {
  await tx.execute(sql`update email_messages set ai_batch_id = null, extract_releases = extract_releases + 1
    where household_id = ${householdId} and id = ${id} and stage = 'discovered'`);
}

/** Fails every message still waiting in a batch (its mailbox was disconnected: nothing will ever collect it). */
export async function failBatch(
  tx: Tx,
  householdId: string,
  batchId: string,
  nowIso: string,
): Promise<number> {
  const res =
    await tx.execute(sql`update email_messages set stage = 'failed', processed_at = ${nowIso}::timestamptz,
      ai_batch_id = null
    where household_id = ${householdId} and stage = 'discovered' and ai_batch_id = ${batchId}`);
  return res.rowCount ?? 0;
}

/** Batches that still hold messages of an active mailbox (a paused one resumes where it was). Reservations are not batches. */
export async function openBatchIds(tx: Tx, householdId: string): Promise<string[]> {
  const res = await tx.execute<{ ai_batch_id: string }>(sql`select distinct m.ai_batch_id
    from email_messages m join email_connections c on c.id = m.connection_id and c.household_id = m.household_id
    where m.household_id = ${householdId} and m.stage = 'discovered' and m.ai_batch_id is not null
      and m.ai_batch_id not like ${RESERVATION_PREFIX + "%"} and c.status = 'active'`);
  return res.rows.map((r) => r.ai_batch_id);
}

/** Messages of a connection's backfill already sent to the model (charged: in a batch, or finished after one). */
export async function backfillSent(tx: Tx, householdId: string, connectionId: string): Promise<number> {
  const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from email_messages
    where household_id = ${householdId} and connection_id = ${connectionId} and intake = 'backfill'
      and extract_charged_at is not null`);
  return Number(res.rows[0]?.n ?? 0);
}

/** The backfill hit its total cap: what is still waiting will not be extracted. Returns how many. */
export async function skipRestOfBackfill(
  tx: Tx,
  householdId: string,
  connectionId: string,
  nowIso: string,
): Promise<number> {
  const res = await tx.execute(sql`update email_messages set stage = 'prefiltered_out',
      processed_at = ${nowIso}::timestamptz
    where household_id = ${householdId} and connection_id = ${connectionId} and intake = 'backfill'
      and stage = 'discovered' and ai_batch_id is null`);
  return res.rowCount ?? 0;
}

/** Domains the household watches: its items' provider domains and its (and the global) `watch` sender rules. */
export async function watchedDomains(tx: Tx, householdId: string): Promise<string[]> {
  const res = await tx.execute<{ d: string }>(sql`
    select lower(provider_domain) as d from recurring_items
      where household_id = ${householdId} and provider_domain is not null and deleted_at is null
    union
    select lower(domain) from sender_rules
      where rule = 'watch' and (household_id is null or household_id = ${householdId})`);
  return res.rows.map((r) => r.d);
}

/** Connections that have messages of this intake waiting (no batch yet). */
export async function connectionsWithPending(
  tx: Tx,
  householdId: string,
  intake: "discover" | "backfill",
): Promise<string[]> {
  const res = await tx.execute<{ connection_id: string }>(sql`select distinct m.connection_id
    from email_messages m join email_connections c on c.id = m.connection_id and c.household_id = m.household_id
    where m.household_id = ${householdId} and m.stage = 'discovered' and m.intake = ${intake}
      and m.ai_batch_id is null and c.status = 'active' and c.token_ciphertext is not null`);
  return res.rows.map((r) => r.connection_id);
}

// ===== Household facts =====
export interface HouseholdFacts {
  timezone: string;
  autoApplyEnabled: boolean;
}

export async function householdFacts(tx: Tx, householdId: string): Promise<HouseholdFacts | null> {
  const res = await tx.execute<Row>(
    sql`select timezone, auto_apply_enabled from households where id = ${householdId}`,
  );
  const r = res.rows[0];
  return r ? { timezone: str(r.timezone), autoApplyEnabled: r.auto_apply_enabled === true } : null;
}

/** Domains the household (and the global seed list) told us to ignore. */
export async function ignoredDomains(tx: Tx, householdId: string): Promise<string[]> {
  const res = await tx.execute<{ domain: string }>(sql`select domain from sender_rules
    where rule = 'ignore' and (household_id is null or household_id = ${householdId})`);
  return res.rows.map((r) => r.domain);
}

export async function memberIds(tx: Tx, householdId: string): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`select user_id from household_members
    where household_id = ${householdId} and left_at is null order by joined_at`);
  return res.rows.map((r) => r.user_id);
}

// ===== Items =====
/** Every item the matcher may consider. `confirmed` is "not waiting for a person to confirm it". */
export async function loadMatchables(tx: Tx, householdId: string): Promise<MatchableItem[]> {
  const res =
    await tx.execute<Row>(sql`select id, name, provider_name, provider_domain, account_last4, category, status
    from recurring_items where household_id = ${householdId} and deleted_at is null order by id`);
  return res.rows.map((r) => ({
    id: str(r.id),
    providerName: strOrNull(r.provider_name) ?? str(r.name),
    providerDomain: strOrNull(r.provider_domain),
    accountLast4: strOrNull(r.account_last4),
    // Items carry the bare category (no insurance subtype is stored); the matcher treats it as compatible.
    kind: str(r.category),
    confirmed: r.status !== "pending_review",
  }));
}

function renewalOf(r: Row | undefined): RenewalDetails | null {
  if (!r) return null;
  return {
    autoRenews: r.auto_renews as RenewalDetails["autoRenews"],
    coverageStart: strOrNull(r.coverage_start),
    coverageEnd: strOrNull(r.coverage_end),
    cancelBy: strOrNull(r.cancel_by),
    decisionBy: strOrNull(r.decision_by),
    shopAroundOn: strOrNull(r.shop_around_on),
    previousAmountCents: centsOrNull(r.previous_amount_cents),
    priceChangedOn: strOrNull(r.price_changed_on),
  };
}

/** The matched item with the engine's own expected amount (hard rule 4) and its upcoming bills. */
export async function loadItemContext(
  tx: Tx,
  householdId: string,
  itemId: string,
  nowIso: string,
): Promise<ItemContext | null> {
  const item = (
    await tx.execute<Row>(sql`select id, name, category, rrule, amount_type, amount_cents::text as amount_cents,
        owner_type, owner_user_id
      from recurring_items where id = ${itemId} and household_id = ${householdId} and deleted_at is null`)
  ).rows[0];
  if (!item) return null;
  const renewal = (
    await tx.execute<Row>(sql`select auto_renews, coverage_start::text as coverage_start,
        coverage_end::text as coverage_end, cancel_by::text as cancel_by, decision_by::text as decision_by,
        shop_around_on::text as shop_around_on, previous_amount_cents::text as previous_amount_cents,
        price_changed_on::text as price_changed_on
      from renewal_details where item_id = ${itemId} and household_id = ${householdId}`)
  ).rows[0];
  const occurrences = (
    await tx.execute<Row>(sql`select id, scheduled_on::text as scheduled_on, due_on::text as due_on,
        actual_amount_cents::text as actual_amount_cents
      from occurrences where item_id = ${itemId} and household_id = ${householdId} and status = 'scheduled'
      order by due_on, id limit 24`)
  ).rows;
  // The expected amount is the engine's, from the same projection the plan uses.
  const loaded = await loadEngineInput(tx, householdId, { nowIso, lenient: true });
  const engineItem = loaded && loaded.ready ? loaded.input.items.find((i) => i.id === itemId) : undefined;
  return {
    id: str(item.id),
    name: str(item.name),
    category: str(item.category),
    rrule: str(item.rrule),
    amountType: item.amount_type as ItemContext["amountType"],
    amountCents: centsOrNull(item.amount_cents),
    expectedAmountCents: engineItem ? itemAmount(engineItem).cents : centsOrNull(item.amount_cents),
    ownerType: item.owner_type as ItemContext["ownerType"],
    ownerUserId: strOrNull(item.owner_user_id),
    scheduled: occurrences.map((o) => ({
      id: str(o.id),
      scheduledOn: str(o.scheduled_on),
      dueOn: str(o.due_on),
      actualAmountCents: centsOrNull(o.actual_amount_cents),
    })),
    renewal: renewalOf(renewal),
  };
}

/**
 * Is this sender domain new to the household? (Q-235, owner/tech-lead decision.) It is KNOWN, so `false`, once
 *   - a person CONFIRMED (or edited) a review item from that domain in this household, or
 *   - an automatic change from that domain really changed something (its `applied_changes.before` is not `{}`).
 * A no-op automatic row (an identical notice, `before = {}`) never counts, so trust cannot be bootstrapped by the
 * pipeline itself (N1): a person decides first. Queued, ignored and expired items do not count.
 *
 * Any error answers `true` (first seen): the safe answer sends the item to a person. The query runs in a savepoint so
 * an error cannot abort the surrounding transaction.
 */
export async function senderFirstSeen(tx: Tx, householdId: string, fromDomain: string): Promise<boolean> {
  try {
    return await tx.transaction(async (savepoint) => {
      const res = await savepoint.execute(
        sql`select 1 from extracted_items e
          where e.household_id = ${householdId} and lower(e.message_meta ->> 'fromDomain') = ${fromDomain.toLowerCase()}
            and ((e.state in ('confirmed','edited') and e.decided_by is not null)
              or (e.state = 'auto_applied' and exists (
                    select 1 from applied_changes c
                     where c.id = e.applied_change_id and c.household_id = e.household_id
                       and c.before is not null and c.before <> '{}'::jsonb)))
          limit 1`,
      );
      return res.rows.length === 0;
    });
  } catch {
    return true;
  }
}

// ===== Writes =====
export interface NewExtractedItem {
  householdId: string;
  messageId: string;
  extractorVersion: string;
  modelId: string;
  fields: object;
  evidence: object[];
  checks: object;
  messageMeta: object;
  matchItemId: string | null;
  matchType: "new" | "update" | "decision" | "duplicate";
  /** `auto_applied` rows carry the change that applied them and the time; the rest are `queued`. */
  state: "queued" | "auto_applied";
  appliedChangeId: string | null;
  nowIso: string;
}

export async function insertExtractedItem(tx: Tx, row: NewExtractedItem): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`insert into extracted_items
      (household_id, source, message_id, extractor_version, model_id, fields, evidence, checks, message_meta,
       match_item_id, match_type, state, decided_at, applied_change_id)
    values (${row.householdId}, 'email', ${row.messageId}, ${row.extractorVersion}, ${row.modelId},
      ${JSON.stringify(row.fields)}::jsonb, ${JSON.stringify(row.evidence)}::jsonb, ${JSON.stringify(row.checks)}::jsonb,
      ${JSON.stringify(row.messageMeta)}::jsonb, ${row.matchItemId}, ${row.matchType}, ${row.state},
      ${row.state === "auto_applied" ? sql`${row.nowIso}::timestamptz` : sql`null`}, ${row.appliedChangeId})
    returning id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("extracted item insert returned no id");
  return id;
}

/**
 * The automatic change's undo-log row: `applied_by` null (automatic), `origin` email, and an undo window of
 * `UNDO_WINDOW_DAYS` computed on the UTC wall clock so DST never shifts it. The same expression as the API's
 * `insertApplied` (apps/api/src/modules/review/repo.ts); both take the window from the contracts constant.
 */
export async function insertAutomaticChange(
  tx: Tx,
  householdId: string,
  c: { entityId: string; before: object; after: object; appliedAtIso: string },
): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`insert into applied_changes
      (household_id, origin, entity_type, entity_id, before, after, applied_by, applied_at, undo_until)
    values (${householdId}, 'email', 'item', ${c.entityId}, ${JSON.stringify(c.before)}::jsonb,
      ${JSON.stringify(c.after)}::jsonb, null, ${c.appliedAtIso}::timestamptz,
      ((${c.appliedAtIso}::timestamptz at time zone 'UTC') + make_interval(days => ${UNDO_WINDOW_DAYS})) at time zone 'UTC')
    returning id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("applied change insert returned no id");
  return id;
}

export async function audit(
  tx: Tx,
  householdId: string,
  action: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (${householdId}, null, 'system', ${action}, ${entityType}, ${entityId})`);
}

/** Today's queued email items for the household (the "more than 3 -> daily digest" rule). */
export async function queuedToday(tx: Tx, householdId: string, sinceIso: string): Promise<number> {
  const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from extracted_items
    where household_id = ${householdId} and source = 'email' and state = 'queued'
      and created_at >= ${sinceIso}::timestamptz`);
  return Number(res.rows[0]?.n ?? 0);
}
