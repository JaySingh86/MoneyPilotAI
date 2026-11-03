// SQL for the items module. Always called inside `withHouseholdTx`. Dates are cast to text and bigints to
// text in SQL (the driver would return JS Dates and strings), then converted by the mappers below.
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@mp/db";
import type { Balance, Item, Occurrence, PlannedExpense, Schedule } from "@mp/contracts";
import { scheduleFromRRule } from "@mp/engine";

type Row = Record<string, unknown>;

function cents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("money out of range");
  return n;
}
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const ITEM_COLUMNS = sql`i.id, i.household_id, i.direction, i.kind, i.category, i.name, i.provider_name,
  i.provider_domain, i.amount_type, i.amount_cents::text as amount_cents, i.rrule, i.dtstart::text as dtstart,
  i.until::text as until, i.weekend_rule, i.owner_type, i.owner_user_id, i.status, i.source, i.account_last4,
  i.paid_from, i.marked_possibly_unused, i.subcategory, i.movable, i.on_bills_page, i.notes, i.version,
  to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
  to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
  (r.item_id is not null) as has_renewal, r.auto_renews, r.coverage_start::text as coverage_start,
  r.coverage_end::text as coverage_end, r.cancel_by::text as cancel_by, r.decision_by::text as decision_by,
  r.shop_around_on::text as shop_around_on, r.previous_amount_cents::text as previous_amount_cents,
  r.price_changed_on::text as price_changed_on`;
const ITEM_FROM = sql`recurring_items i left join renewal_details r on r.item_id = i.id`;

export function toItem(r: Row): Item {
  const schedule: Schedule = scheduleFromRRule({
    rrule: str(r.rrule),
    dtstart: str(r.dtstart),
    until: strOrNull(r.until),
  });
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    direction: r.direction as Item["direction"],
    kind: r.kind as Item["kind"],
    category: r.category as Item["category"],
    name: str(r.name),
    providerName: strOrNull(r.provider_name),
    providerDomain: strOrNull(r.provider_domain),
    amountType: r.amount_type as Item["amountType"],
    amountCents: cents(r.amount_cents),
    schedule,
    weekendRule: r.weekend_rule as Item["weekendRule"],
    ownerType: r.owner_type as Item["ownerType"],
    ownerUserId: strOrNull(r.owner_user_id),
    status: r.status as Item["status"],
    source: r.source as Item["source"],
    accountLast4: strOrNull(r.account_last4),
    paidFrom: r.paid_from as Item["paidFrom"],
    markedPossiblyUnused: r.marked_possibly_unused === true,
    subcategory: strOrNull(r.subcategory),
    movable: r.movable === null ? null : r.movable === true,
    onBillsPage: r.on_bills_page === true,
    notes: strOrNull(r.notes),
    renewal:
      r.has_renewal === true
        ? {
            autoRenews: r.auto_renews as "yes" | "no" | "rolls_over",
            coverageStart: strOrNull(r.coverage_start),
            coverageEnd: strOrNull(r.coverage_end),
            cancelBy: strOrNull(r.cancel_by),
            decisionBy: strOrNull(r.decision_by),
            shopAroundOn: strOrNull(r.shop_around_on),
            previousAmountCents: cents(r.previous_amount_cents),
            priceChangedOn: strOrNull(r.price_changed_on),
          }
        : null,
    version: Number(r.version),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export interface ItemFilter {
  direction?: string;
  kind?: string;
  category?: string;
  owner?: string;
  amountType?: string;
  onBillsPage?: boolean;
  after?: string;
}

export async function listItems(tx: Tx, householdId: string, f: ItemFilter, limit: number): Promise<Item[]> {
  const where: SQL[] = [sql`i.household_id = ${householdId}`, sql`i.deleted_at is null`];
  if (f.direction) where.push(sql`i.direction = ${f.direction}::item_direction`);
  if (f.kind) where.push(sql`i.kind = ${f.kind}::item_kind`);
  if (f.category) where.push(sql`i.category = ${f.category}`);
  if (f.amountType) where.push(sql`i.amount_type = ${f.amountType}`);
  if (f.onBillsPage !== undefined) where.push(sql`i.on_bills_page = ${f.onBillsPage}`);
  if (f.owner === "both" || f.owner === "split") where.push(sql`i.owner_type = ${f.owner}::owner_type`);
  else if (f.owner) where.push(sql`(i.owner_user_id = ${f.owner} or i.owner_type in ('both','split'))`);
  if (f.after) where.push(sql`i.id > ${f.after}`);
  const res = await tx.execute(
    sql`select ${ITEM_COLUMNS} from ${ITEM_FROM} where ${sql.join(where, sql` and `)} order by i.id limit ${limit}`,
  );
  return res.rows.map(toItem);
}

export async function getItem(tx: Tx, householdId: string, id: string, lock = false): Promise<Item | null> {
  const res = await tx.execute(
    sql`select ${ITEM_COLUMNS} from ${ITEM_FROM}
      where i.id = ${id} and i.household_id = ${householdId} and i.deleted_at is null ${lock ? sql`for update of i` : sql``}`,
  );
  const row = res.rows[0];
  return row ? toItem(row) : null;
}

/** Column values for an item insert/update, keyed by SQL column name. */
export type ItemColumns = Record<string, unknown>;

export async function insertItem(
  tx: Tx,
  householdId: string,
  userId: string,
  c: ItemColumns,
): Promise<string> {
  const cols = Object.keys(c);
  const res = await tx.execute<{ id: string }>(sql`insert into recurring_items
      (household_id, created_by, ${sql.join(
        cols.map((k) => sql.identifier(k)),
        sql`, `,
      )})
    values (${householdId}, ${userId}, ${sql.join(
      cols.map((k) => castFor(k, c[k])),
      sql`, `,
    )}) returning id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("insert returned no id");
  return id;
}

function castFor(column: string, value: unknown): SQL {
  if (column === "dtstart" || column === "until") return sql`${value}::date`;
  if (column === "direction") return sql`${value}::item_direction`;
  if (column === "kind") return sql`${value}::item_kind`;
  if (column === "owner_type") return sql`${value}::owner_type`;
  return sql`${value}`;
}

export async function updateItem(
  tx: Tx,
  id: string,
  expectedVersion: number,
  c: ItemColumns,
): Promise<boolean> {
  const sets = Object.keys(c).map((k) => sql`${sql.identifier(k)} = ${castFor(k, c[k])}`);
  const res = await tx.execute(
    sql`update recurring_items set ${sql.join(sets, sql`, `)} where id = ${id} and version = ${expectedVersion}`,
  );
  return (res.rowCount ?? 0) === 1;
}

export async function softDeleteItem(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`update recurring_items set deleted_at = now() where id = ${id}`);
}

export async function isPrimaryIncome(tx: Tx, householdId: string, itemId: string): Promise<boolean> {
  const res = await tx.execute(
    sql`select 1 from households where id = ${householdId} and primary_income_item_id = ${itemId}`,
  );
  return res.rows.length > 0;
}

export async function isMember(tx: Tx, householdId: string, userId: string): Promise<boolean> {
  const res = await tx.execute(
    sql`select 1 from household_members where household_id = ${householdId} and user_id = ${userId} and left_at is null`,
  );
  return res.rows.length > 0;
}

export async function householdTimezone(tx: Tx, householdId: string): Promise<string | null> {
  const res = await tx.execute<{ timezone: string }>(
    sql`select timezone from households where id = ${householdId}`,
  );
  return res.rows[0]?.timezone ?? null;
}

export async function putRenewal(
  tx: Tx,
  householdId: string,
  itemId: string,
  r: {
    autoRenews: string;
    coverageStart: string | null;
    coverageEnd: string | null;
    cancelBy: string | null;
    decisionBy: string | null;
    shopAroundOn: string | null;
    previousAmountCents: number | null;
    priceChangedOn: string | null;
  },
): Promise<void> {
  await tx.execute(sql`insert into renewal_details
      (item_id, household_id, auto_renews, coverage_start, coverage_end, cancel_by, decision_by, shop_around_on,
       previous_amount_cents, price_changed_on)
    values (${itemId}, ${householdId}, ${r.autoRenews}, ${r.coverageStart}::date, ${r.coverageEnd}::date,
       ${r.cancelBy}::date, ${r.decisionBy}::date, ${r.shopAroundOn}::date, ${r.previousAmountCents},
       ${r.priceChangedOn}::date)
    on conflict (item_id) do update set auto_renews = excluded.auto_renews, coverage_start = excluded.coverage_start,
       coverage_end = excluded.coverage_end, cancel_by = excluded.cancel_by, decision_by = excluded.decision_by,
       shop_around_on = excluded.shop_around_on, previous_amount_cents = excluded.previous_amount_cents,
       price_changed_on = excluded.price_changed_on`);
}

export async function listHistory(tx: Tx, itemId: string) {
  const res =
    await tx.execute(sql`select id, occurred_on::text as occurred_on, amount_cents::text as amount_cents, source
    from item_amount_history where item_id = ${itemId} order by occurred_on, source`);
  return res.rows.map((r) => ({
    id: str(r.id),
    occurredOn: str(r.occurred_on),
    amountCents: cents(r.amount_cents) ?? 0,
    source: r.source as Item["source"],
  }));
}

export async function upsertHistory(
  tx: Tx,
  householdId: string,
  itemId: string,
  occurredOn: string,
  amountCents: number,
): Promise<void> {
  await tx.execute(sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
    values (${householdId}, ${itemId}, ${occurredOn}::date, ${amountCents}, 'manual')
    on conflict (item_id, occurred_on, source) do update set amount_cents = excluded.amount_cents`);
}

// ===== Occurrences =====
const OCC_COLUMNS = sql`o.id, o.household_id, o.item_id, o.scheduled_on::text as scheduled_on, o.due_on::text as due_on,
  o.actual_amount_cents::text as actual_amount_cents, o.status, o.paid_on::text as paid_on, o.marked_by, o.moved_by,
  o.version`;

export function toOccurrence(r: Row): Occurrence {
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    itemId: str(r.item_id),
    scheduledOn: str(r.scheduled_on),
    dueOn: str(r.due_on),
    actualAmountCents: cents(r.actual_amount_cents),
    status: r.status as Occurrence["status"],
    paidOn: strOrNull(r.paid_on),
    markedBy: strOrNull(r.marked_by),
    movedBy: strOrNull(r.moved_by),
    version: Number(r.version),
  };
}

export async function listOccurrences(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
  itemId?: string,
): Promise<Occurrence[]> {
  const res = await tx.execute(sql`select ${OCC_COLUMNS} from occurrences o
    join recurring_items i on i.id = o.item_id and i.deleted_at is null
    where o.household_id = ${householdId} and o.due_on between ${from}::date and ${to}::date
      ${itemId ? sql`and o.item_id = ${itemId}` : sql``}
    order by o.due_on, o.item_id`);
  return res.rows.map(toOccurrence);
}

export async function getOccurrence(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<{
  occurrence: Occurrence;
  direction: "inflow" | "outflow";
  ownerType: Item["ownerType"];
  ownerUserId: string | null;
} | null> {
  // An occurrence of a soft-deleted item is gone for the API (G1 L-3).
  const res = await tx.execute(sql`select ${OCC_COLUMNS}, i.direction, i.owner_type, i.owner_user_id
    from occurrences o join recurring_items i on i.id = o.item_id
    where o.id = ${id} and o.household_id = ${householdId} and i.deleted_at is null for update of o`);
  const row = res.rows[0];
  return row
    ? {
        occurrence: toOccurrence(row),
        direction: row.direction as "inflow" | "outflow",
        ownerType: row.owner_type as Item["ownerType"],
        ownerUserId: strOrNull(row.owner_user_id),
      }
    : null;
}

export async function updateOccurrence(
  tx: Tx,
  id: string,
  expectedVersion: number,
  c: Record<string, unknown>,
): Promise<boolean> {
  const sets = Object.keys(c).map((k) =>
    k === "due_on" || k === "paid_on"
      ? sql`${sql.identifier(k)} = ${c[k]}::date`
      : sql`${sql.identifier(k)} = ${c[k]}`,
  );
  const res = await tx.execute(
    sql`update occurrences set ${sql.join(sets, sql`, `)} where id = ${id} and version = ${expectedVersion}`,
  );
  return (res.rowCount ?? 0) === 1;
}

// ===== Planned expenses =====
const PLANNED_COLUMNS = sql`id, household_id, name, amount_cents::text as amount_cents, due_on::text as due_on, owner_type,
  owner_user_id, goal_id, status, version, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`;

function toPlanned(r: Row): PlannedExpense {
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    name: str(r.name),
    amountCents: cents(r.amount_cents) ?? 0,
    dueOn: str(r.due_on),
    ownerType: r.owner_type as PlannedExpense["ownerType"],
    ownerUserId: strOrNull(r.owner_user_id),
    goalId: strOrNull(r.goal_id),
    status: r.status as PlannedExpense["status"],
    version: Number(r.version),
    createdAt: str(r.created_at),
  };
}

export async function listPlanned(tx: Tx, householdId: string, status?: string): Promise<PlannedExpense[]> {
  const res = await tx.execute(sql`select ${PLANNED_COLUMNS} from planned_expenses
    where household_id = ${householdId} ${status ? sql`and status = ${status}` : sql``} order by due_on, id`);
  return res.rows.map(toPlanned);
}

export async function getPlanned(tx: Tx, householdId: string, id: string): Promise<PlannedExpense | null> {
  const res = await tx.execute(
    sql`select ${PLANNED_COLUMNS} from planned_expenses where id = ${id} and household_id = ${householdId} for update`,
  );
  const row = res.rows[0];
  return row ? toPlanned(row) : null;
}

export async function insertPlanned(
  tx: Tx,
  householdId: string,
  userId: string,
  p: {
    name: string;
    amountCents: number;
    dueOn: string;
    ownerType: string;
    ownerUserId: string | null;
    goalId: string | null;
    status: string;
  },
): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`insert into planned_expenses
      (household_id, name, amount_cents, due_on, owner_type, owner_user_id, goal_id, status, created_by)
    values (${householdId}, ${p.name}, ${p.amountCents}, ${p.dueOn}::date, ${p.ownerType}::owner_type,
      ${p.ownerUserId}, ${p.goalId}, ${p.status}, ${userId}) returning id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("insert returned no id");
  return id;
}

export async function updatePlanned(
  tx: Tx,
  id: string,
  expectedVersion: number,
  c: Record<string, unknown>,
): Promise<boolean> {
  const sets = Object.keys(c).map((k) =>
    k === "due_on"
      ? sql`due_on = ${c[k]}::date`
      : k === "owner_type"
        ? sql`owner_type = ${c[k]}::owner_type`
        : sql`${sql.identifier(k)} = ${c[k]}`,
  );
  const res = await tx.execute(
    sql`update planned_expenses set ${sql.join(sets, sql`, `)} where id = ${id} and version = ${expectedVersion}`,
  );
  return (res.rowCount ?? 0) === 1;
}

export async function deletePlanned(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`delete from planned_expenses where id = ${id}`);
}

// ===== Balances =====
const BALANCE_COLUMNS = sql`id, label, amount_cents::text as amount_cents, as_of::text as as_of, source,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`;

function toBalance(r: Row): Balance {
  return {
    id: str(r.id),
    label: str(r.label),
    amountCents: cents(r.amount_cents) ?? 0,
    asOf: str(r.as_of),
    source: r.source as Balance["source"],
    createdAt: str(r.created_at),
  };
}

export async function insertBalance(
  tx: Tx,
  householdId: string,
  userId: string,
  b: { label: string; amountCents: number; asOf: string },
): Promise<Balance> {
  const res =
    await tx.execute(sql`insert into balances (household_id, label, amount_cents, as_of, source, recorded_by)
    values (${householdId}, ${b.label}, ${b.amountCents}, ${b.asOf}::date, 'manual', ${userId})
    returning ${BALANCE_COLUMNS}`);
  const row = res.rows[0];
  if (!row) throw new Error("insert returned no row");
  return toBalance(row);
}

export async function latestBalance(tx: Tx, householdId: string): Promise<Balance | null> {
  const res = await tx.execute(sql`select ${BALANCE_COLUMNS} from balances where household_id = ${householdId}
    order by as_of desc, created_at desc limit 1`);
  const row = res.rows[0];
  return row ? toBalance(row) : null;
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

/**
 * Leave: the leaver's items go to the remaining member (BACKEND_PLAN §6). Soft-deleted items are reassigned
 * too, so an owner is always a current member.
 */
export async function reassignOwner(tx: Tx, householdId: string, fromUserId: string, toUserId: string) {
  const items = await tx.execute(sql`update recurring_items set owner_user_id = ${toUserId}
    where household_id = ${householdId} and owner_type = 'member' and owner_user_id = ${fromUserId}`);
  const planned = await tx.execute(sql`update planned_expenses set owner_user_id = ${toUserId}
    where household_id = ${householdId} and owner_type = 'member' and owner_user_id = ${fromUserId}`);
  return { items: items.rowCount ?? 0, plannedExpenses: planned.rowCount ?? 0 };
}
