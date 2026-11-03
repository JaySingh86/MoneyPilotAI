// The occurrence materializer (BACKEND_PLAN §7.1, ADR-006), shared by the API (synchronous rebuild on an
// item change), the worker job (`occurrences.materialize`, nightly) and the seed loader. It runs inside a
// caller-provided transaction, as mp_api or mp_worker: RLS scopes it to one household either way.
//
// Window: 35 days back to 400 days ahead of the household-local "today". Upserts are keyed on
// (item_id, scheduled_on). A schedule change deletes and rebuilds FUTURE `scheduled` rows only; paid,
// received and skipped rows, and anything before today, are never touched.
import { sql } from "drizzle-orm";
import { applyWeekendRule, expandSchedule, householdDate, parseDate, scheduleFromRRule } from "@mp/engine";
import type { WeekendRule } from "@mp/engine";
import type { Tx } from "../tx";

export const MATERIALIZE_PAST_DAYS = 35;
export const MATERIALIZE_FUTURE_DAYS = 400;

/** The columns of a recurring item the materializer reads. Dates are `YYYY-MM-DD` strings. */
export interface ScheduledItem {
  id: string;
  rrule: string;
  dtstart: string;
  until: string | null;
  weekendRule: WeekendRule;
  /** Only active, not deleted items get new occurrences. */
  materialize: boolean;
}

export interface PlannedOccurrence {
  scheduledOn: string;
  dueOn: string;
}

/**
 * Pure: the occurrences an item should have from `fromOffsetDays` relative to `today` through +400 days.
 * `due_on` is the scheduled date after the weekend rule. Returns [] when the item is not materialized.
 */
export function planOccurrences(
  item: ScheduledItem,
  today: string,
  fromOffsetDays: number = -MATERIALIZE_PAST_DAYS,
): PlannedOccurrence[] {
  if (!item.materialize) return [];
  const base = parseDate(today, "today");
  const schedule = scheduleFromRRule({ rrule: item.rrule, dtstart: item.dtstart, until: item.until });
  const dates = expandSchedule(
    schedule,
    base.add({ days: fromOffsetDays }),
    base.add({ days: MATERIALIZE_FUTURE_DAYS }),
  );
  return dates.map((d) => ({
    scheduledOn: d.toString(),
    dueOn: applyWeekendRule(d, item.weekendRule).toString(),
  }));
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  rrule: string;
  dtstart: string;
  until: string | null;
  weekend_rule: WeekendRule;
  materialize: boolean;
}

async function loadItem(tx: Tx, itemId: string): Promise<ScheduledItem | null> {
  // `::text` on dates: the driver would otherwise return a JS Date at local midnight.
  const res = await tx.execute<ItemRow>(sql`select id, rrule, dtstart::text as dtstart, until::text as until,
      weekend_rule, (status = 'active' and deleted_at is null) as materialize
    from recurring_items where id = ${itemId}`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    rrule: row.rrule,
    dtstart: row.dtstart,
    until: row.until,
    weekendRule: row.weekend_rule,
    materialize: row.materialize,
  };
}

async function insertPlanned(
  tx: Tx,
  itemId: string,
  planned: PlannedOccurrence[],
  /** Rebuild: a kept row that was not moved by hand takes the new weekend-rule date. */
  refreshDue = false,
): Promise<number> {
  if (planned.length === 0) return 0;
  const res = await tx.execute(sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
    select i.household_id, i.id, p.scheduled_on, p.due_on
      from recurring_items i,
           jsonb_to_recordset(${JSON.stringify(planned.map((p) => ({ scheduled_on: p.scheduledOn, due_on: p.dueOn })))}::jsonb)
             as p(scheduled_on date, due_on date)
     where i.id = ${itemId}
    ${
      refreshDue
        ? sql`on conflict (item_id, scheduled_on) do update set due_on = excluded.due_on
            where occurrences.status = 'scheduled' and occurrences.moved_by is null
              and occurrences.due_on <> excluded.due_on`
        : sql`on conflict (item_id, scheduled_on) do nothing`
    }`);
  return res.rowCount ?? 0;
}

export interface MaterializeResult {
  inserted: number;
  deleted: number;
}

/**
 * Adds the occurrences missing from the window (35 days back to 400 ahead). Existing rows are never
 * changed. Run on item creation, and nightly to extend the horizon. Idempotent.
 */
export async function extendOccurrences(tx: Tx, itemId: string, today: string): Promise<MaterializeResult> {
  const item = await loadItem(tx, itemId);
  if (!item) return { inserted: 0, deleted: 0 };
  return { inserted: await insertPlanned(tx, itemId, planOccurrences(item, today)), deleted: 0 };
}

/**
 * Rebuilds the future after a schedule change: deletes `scheduled` occurrences dated today or later and
 * recreates them from the current schedule. Past rows and paid, received or skipped rows stay as they
 * are. A future `scheduled` row that the household moved by hand or gave an actual amount survives when
 * its scheduled date is still in the new schedule (Q-053); one whose date disappeared is deleted with the
 * rest. Also removes the future of an item that was paused, ended or deleted.
 */
export async function rebuildFutureOccurrences(
  tx: Tx,
  itemId: string,
  today: string,
): Promise<MaterializeResult> {
  const item = await loadItem(tx, itemId);
  if (!item) return { inserted: 0, deleted: 0 };
  const planned = planOccurrences(item, today, 0);
  const keepDates = JSON.stringify(planned.map((p) => p.scheduledOn));
  const removed = await tx.execute(sql`delete from occurrences
    where item_id = ${itemId} and status = 'scheduled' and scheduled_on >= ${today}::date
      and not ((moved_by is not null or actual_amount_cents is not null)
               and scheduled_on::text in (select jsonb_array_elements_text(${keepDates}::jsonb)))`);
  const inserted = await insertPlanned(tx, itemId, planned, true);
  return { inserted, deleted: removed.rowCount ?? 0 };
}

/** `extendOccurrences` for every active item of the household the transaction is scoped to. */
export async function materializeHousehold(
  tx: Tx,
  householdId: string,
  today: string,
): Promise<MaterializeResult> {
  const items = await tx.execute<{ id: string }>(
    sql`select id from recurring_items
      where household_id = ${householdId} and status = 'active' and deleted_at is null order by id`,
  );
  let inserted = 0;
  for (const { id } of items.rows) inserted += (await extendOccurrences(tx, id, today)).inserted;
  return { inserted, deleted: 0 };
}

/** The household-local date for a UTC instant: `householdToday(tz, new Date().toISOString())`. */
export { householdDate as householdToday };

/** The `occurrences.materialize` job body for one household (BACKEND_PLAN §9): one item, or all of them. */
export async function materializeForJob(
  tx: Tx,
  job: { householdId: string; itemId?: string | undefined; rebuild?: boolean | undefined },
  nowIso: string,
): Promise<MaterializeResult> {
  const res = await tx.execute<{ timezone: string }>(
    sql`select timezone from households where id = ${job.householdId}`,
  );
  const timezone = res.rows[0]?.timezone;
  if (!timezone) return { inserted: 0, deleted: 0 }; // household deleted since the job was queued
  const today = householdDate(nowIso, timezone);
  if (!job.itemId) return materializeHousehold(tx, job.householdId, today);
  return job.rebuild
    ? rebuildFutureOccurrences(tx, job.itemId, today)
    : extendOccurrences(tx, job.itemId, today);
}
