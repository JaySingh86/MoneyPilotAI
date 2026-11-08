// SQL for the review queue and the applied-changes log. Always called inside `withHouseholdTx`.
// Timestamps are read as UTC ISO strings; cursors use microsecond text so keyset paging never skips a row.
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@mp/db";
import { UNDO_WINDOW_DAYS, type ExtractedFields, type ReviewState } from "@mp/contracts";

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
const micros = (col: string) =>
  sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

// ===== Review items =====
export interface ReviewRow {
  id: string;
  source: "email" | "csv";
  state: ReviewState;
  matchType: "new" | "update" | "decision" | "duplicate";
  matchItemId: string | null;
  matchItemName: string | null;
  messageMeta: Record<string, unknown> | null;
  /** Raw stored JSON; the service parses it with the contract schema. */
  fields: unknown;
  evidence: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedChangeId: string | null;
  createdAt: string;
  evidenceStale: boolean;
  /** Microsecond text of the list sort key (created_at while queued, else decided_at), for the cursor. */
  sortCursor: string;
}

/** Queued items are worked oldest first; decided ones are listed by when they were decided (or applied). */
const SORT_KEY = "coalesce(e.decided_at, e.created_at)";
const REVIEW_COLUMNS = sql`e.id, e.source, e.state, e.match_type, e.match_item_id, i.name as match_item_name,
  e.message_meta, e.fields, e.evidence, e.evidence_stale, e.decided_by, e.applied_change_id,
  ${iso("e.decided_at")} as decided_at, ${iso("e.created_at")} as created_at, ${micros(SORT_KEY)} as sort_cursor`;
const REVIEW_FROM = sql`extracted_items e left join recurring_items i on i.id = e.match_item_id and i.household_id = e.household_id and i.deleted_at is null`;

function toReviewRow(r: Row): ReviewRow {
  return {
    id: str(r.id),
    source: r.source as ReviewRow["source"],
    state: r.state as ReviewState,
    matchType: r.match_type as ReviewRow["matchType"],
    matchItemId: strOrNull(r.match_item_id),
    matchItemName: strOrNull(r.match_item_name),
    messageMeta: (r.message_meta as Record<string, unknown> | null) ?? null,
    fields: r.fields,
    evidence: r.evidence,
    decidedBy: strOrNull(r.decided_by),
    decidedAt: strOrNull(r.decided_at),
    appliedChangeId: strOrNull(r.applied_change_id),
    createdAt: str(r.created_at),
    evidenceStale: r.evidence_stale === true,
    sortCursor: str(r.sort_cursor),
  };
}

export interface PageCursor {
  at: string;
  id: string;
}

/** The queue is oldest first (work it top down); history lists are newest first. */
export async function listReview(
  tx: Tx,
  householdId: string,
  state: ReviewState,
  after: PageCursor | null,
  limit: number,
): Promise<ReviewRow[]> {
  const oldestFirst = state === "queued";
  const where: SQL[] = [sql`e.household_id = ${householdId}`, sql`e.state = ${state}`];
  if (after) {
    where.push(
      oldestFirst
        ? sql`(e.created_at, e.id) > (${after.at}::timestamptz, ${after.id}::uuid)`
        : sql`(${sql.raw(SORT_KEY)}, e.id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
    );
  }
  const order = oldestFirst ? sql`e.created_at, e.id` : sql`${sql.raw(SORT_KEY)} desc, e.id desc`;
  const res = await tx.execute(
    sql`select ${REVIEW_COLUMNS} from ${REVIEW_FROM} where ${sql.join(where, sql` and `)} order by ${order} limit ${limit}`,
  );
  return res.rows.map(toReviewRow);
}

export async function getReview(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<ReviewRow | null> {
  const res = await tx.execute(
    sql`select ${REVIEW_COLUMNS} from ${REVIEW_FROM}
      where e.id = ${id} and e.household_id = ${householdId} ${lock ? sql`for update of e` : sql``}`,
  );
  const row = res.rows[0];
  return row ? toReviewRow(row) : null;
}

export interface Decision {
  state: "confirmed" | "edited" | "ignored";
  decidedBy: string;
  decidedAt: string;
  appliedChangeId: string | null;
  /** Corrected fields (edit): the stored fields are replaced, the originals kept, the evidence marked stale. */
  fields?: ExtractedFields;
}

/** Moves a queued item to its decided state. False when it was no longer queued. */
export async function decide(tx: Tx, id: string, d: Decision): Promise<boolean> {
  const res = await tx.execute(
    sql`update extracted_items set state = ${d.state}, decided_by = ${d.decidedBy},
        decided_at = ${d.decidedAt}::timestamptz, applied_change_id = ${d.appliedChangeId}
        ${d.fields ? sql`, original_fields = fields, fields = ${json(d.fields)}, evidence_stale = true` : sql``}
      where id = ${id} and state = 'queued'`,
  );
  return (res.rowCount ?? 0) === 1;
}

/**
 * True when an earlier message from this sender domain was applied or confirmed for the same item AND that
 * decision produced an applied change. Duplicates, ignores and no-op confirms do not count (M3).
 * The email pipeline's "sender is not first-seen for this item" gate (BACKEND_PLAN §7.8.2) reads it.
 */
export async function hasPriorDecidedFromSender(
  tx: Tx,
  householdId: string,
  itemId: string,
  fromDomain: string,
): Promise<boolean> {
  const res = await tx.execute(
    sql`select 1 from extracted_items
      where household_id = ${householdId} and match_item_id = ${itemId}
        and state in ('auto_applied','confirmed','edited') and applied_change_id is not null
        and lower(message_meta ->> 'fromDomain') = ${fromDomain.toLowerCase()} limit 1`,
  );
  return res.rows.length > 0;
}

// ===== Applied changes =====
export interface AppliedRow {
  id: string;
  origin: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  appliedBy: string | null;
  appliedAt: string;
  undoUntil: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
  undoable: boolean;
  appliedCursor: string;
}

function appliedColumns(now: string): SQL {
  return sql`c.id, c.origin, c.entity_type, c.entity_id, i.name as entity_name, c.before, c.after, c.applied_by,
    ${iso("c.applied_at")} as applied_at, ${iso("c.undo_until")} as undo_until, ${iso("c.undone_at")} as undone_at,
    c.undone_by, ${micros("c.applied_at")} as applied_cursor,
    (c.undone_at is null and c.undo_until is not null and c.undo_until >= ${now}::timestamptz) as undoable`;
}
const APPLIED_FROM = sql`applied_changes c left join recurring_items i
  on c.entity_type = 'item' and i.id = c.entity_id and i.household_id = c.household_id and i.deleted_at is null`;

function toAppliedRow(r: Row): AppliedRow {
  return {
    id: str(r.id),
    origin: str(r.origin),
    entityType: str(r.entity_type),
    entityId: str(r.entity_id),
    entityName: strOrNull(r.entity_name),
    before: (r.before as Record<string, unknown> | null) ?? null,
    after: r.after as Record<string, unknown>,
    appliedBy: strOrNull(r.applied_by),
    appliedAt: str(r.applied_at),
    undoUntil: strOrNull(r.undo_until),
    undoneAt: strOrNull(r.undone_at),
    undoneBy: strOrNull(r.undone_by),
    undoable: r.undoable === true,
    appliedCursor: str(r.applied_cursor),
  };
}

export async function listApplied(
  tx: Tx,
  householdId: string,
  now: string,
  after: PageCursor | null,
  limit: number,
): Promise<AppliedRow[]> {
  const where: SQL[] = [sql`c.household_id = ${householdId}`];
  if (after) where.push(sql`(c.applied_at, c.id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
  const res = await tx.execute(
    sql`select ${appliedColumns(now)} from ${APPLIED_FROM} where ${sql.join(where, sql` and `)}
      order by c.applied_at desc, c.id desc limit ${limit}`,
  );
  return res.rows.map(toAppliedRow);
}

export async function getApplied(
  tx: Tx,
  householdId: string,
  id: string,
  now: string,
  lock = false,
): Promise<AppliedRow | null> {
  const res = await tx.execute(
    sql`select ${appliedColumns(now)} from ${APPLIED_FROM}
      where c.id = ${id} and c.household_id = ${householdId} ${lock ? sql`for update of c` : sql``}`,
  );
  const row = res.rows[0];
  return row ? toAppliedRow(row) : null;
}

export interface NewAppliedChange {
  origin: "email" | "csv";
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  appliedBy: string;
  appliedAt: string;
}

/** `undo_until` is `applied_at + 30 days`, computed on the UTC wall clock so DST never shifts it. */
export async function insertApplied(tx: Tx, householdId: string, c: NewAppliedChange): Promise<string> {
  const res = await tx.execute<{ id: string }>(
    sql`insert into applied_changes (household_id, origin, entity_type, entity_id, before, after, applied_by, applied_at, undo_until)
      values (${householdId}, ${c.origin}, ${c.entityType}, ${c.entityId},
        ${c.before === null ? sql`null` : json(c.before)}, ${json(c.after)}, ${c.appliedBy}, ${c.appliedAt}::timestamptz,
        ((${c.appliedAt}::timestamptz at time zone 'UTC') + make_interval(days => ${UNDO_WINDOW_DAYS})) at time zone 'UTC')
      returning id`,
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error("applied change insert returned no id");
  return id;
}

/** Marks a change undone. False when it was already undone or its window has passed. */
export async function markUndone(tx: Tx, id: string, userId: string, now: string): Promise<boolean> {
  const res = await tx.execute(
    sql`update applied_changes set undone_at = ${now}::timestamptz, undone_by = ${userId}
      where id = ${id} and undone_at is null and undo_until is not null and undo_until >= ${now}::timestamptz`,
  );
  return (res.rowCount ?? 0) === 1;
}

// ===== Sender rules (household rows only; the global seed list is read-only for app roles) =====
export interface SenderRuleRow {
  id: string;
  domain: string;
  rule: "watch" | "ignore";
  categoryHint: string | null;
  createdBy: string | null;
}

function toSenderRule(r: Row): SenderRuleRow {
  return {
    id: str(r.id),
    domain: str(r.domain),
    rule: r.rule as SenderRuleRow["rule"],
    categoryHint: strOrNull(r.category_hint),
    createdBy: strOrNull(r.created_by),
  };
}

export async function listSenderRules(tx: Tx, householdId: string): Promise<SenderRuleRow[]> {
  const res = await tx.execute(
    sql`select id, domain, rule, category_hint, created_by from sender_rules
      where household_id = ${householdId} order by domain`,
  );
  return res.rows.map(toSenderRule);
}

/** Creates the rule for a domain, or changes the rule of the household's existing one. */
export async function upsertSenderRule(
  tx: Tx,
  householdId: string,
  userId: string,
  r: { domain: string; rule: "watch" | "ignore"; categoryHint: string | null },
): Promise<{ row: SenderRuleRow; created: boolean }> {
  const res = await tx.execute(
    sql`insert into sender_rules (household_id, domain, rule, category_hint, created_by)
      values (${householdId}, ${r.domain}, ${r.rule}, ${r.categoryHint}, ${userId})
      on conflict (household_id, domain) do update set rule = excluded.rule, category_hint = excluded.category_hint
      returning id, domain, rule, category_hint, created_by, (xmax = 0) as created`,
  );
  const row = res.rows[0];
  if (!row) throw new Error("sender rule upsert returned no row");
  return { row: toSenderRule(row), created: row.created === true };
}

export async function audit(
  tx: Tx,
  householdId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (${householdId}, ${userId}, 'user', ${action}, ${entityType}, ${entityId})`);
}

// ===== Automation stats (Q-172) =====
/** Active, live items by how they were found (a `bank` item is in neither group, Q-172). `null` when the household is not visible to the caller (RLS). */
export async function automationCounts(
  tx: Tx,
  householdId: string,
): Promise<{ automated: number; hand: number } | null> {
  const res = await tx.execute(sql`select
      count(*) filter (where i.source in ('email','csv'))::int as automated,
      count(*) filter (where i.source = 'manual')::int as hand
    from households h
    left join recurring_items i on i.household_id = h.id and i.status = 'active' and i.deleted_at is null
    where h.id = ${householdId}
    group by h.id`);
  const row = res.rows[0] as Row | undefined;
  return row ? { automated: Number(row.automated), hand: Number(row.hand) } : null;
}
