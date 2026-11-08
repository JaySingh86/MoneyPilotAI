// SQL for notifications and preferences. RLS already limits a member to their own notifications; the explicit
// user_id filters keep the intent visible and the plans index-friendly.
import { sql } from "drizzle-orm";
import type { Notification, NotificationPreferences, ReminderRule } from "@mp/contracts";
import type { Tx } from "@mp/db";

interface NotificationRow extends Record<string, unknown> {
  id: string;
  kind: Notification["kind"];
  title: string;
  body: string;
  deep_link: string | null;
  send_at_iso: string;
  status: "scheduled" | "sent" | "failed";
  read_at: string | null;
  delivery_channel: "email" | "push" | null;
  delivery_status: NonNullable<Notification["delivery"]>["status"] | null;
}

const COLUMNS = sql`n.id, n.kind, n.title, n.body, n.deep_link,
  to_char(n.send_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as send_at_iso,
  n.status, to_char(n.read_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as read_at,
  d.channel as delivery_channel, d.status as delivery_status`;

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    sentAt: row.send_at_iso,
    status: row.status,
    read: row.read_at !== null,
    readAt: row.read_at,
    delivery:
      row.delivery_channel && row.delivery_status
        ? { channel: row.delivery_channel, status: row.delivery_status }
        : null,
  };
}

export interface ListFilter {
  limit: number;
  /** `send_at` as the database printed it (microseconds) and the row id of the last row of the previous page. */
  after?: { sendAt: string; id: string } | undefined;
  unread: boolean;
}

/** Notifications that are due (or sent), newest first. Cancelled ones are never shown. */
export async function listNotifications(
  tx: Tx,
  householdId: string,
  userId: string,
  filter: ListFilter,
): Promise<Notification[]> {
  const after = filter.after
    ? sql`and (n.send_at, n.id) < (${filter.after.sendAt}::timestamptz, ${filter.after.id}::uuid)`
    : sql``;
  const unread = filter.unread ? sql`and n.read_at is null` : sql``;
  const res = await tx.execute<NotificationRow>(sql`select ${COLUMNS}
    from notifications n
    left join notification_deliveries d on d.notification_id = n.id and d.channel = 'email'
    where n.household_id = ${householdId} and n.user_id = ${userId}
      and n.status <> 'cancelled' and n.send_at <= now() ${after} ${unread}
    order by n.send_at desc, n.id desc
    limit ${filter.limit}`);
  return res.rows.map(toNotification);
}

export async function unreadCount(tx: Tx, householdId: string, userId: string): Promise<number> {
  const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from notifications
    where household_id = ${householdId} and user_id = ${userId}
      and status <> 'cancelled' and send_at <= now() and read_at is null`);
  return Number(res.rows[0]?.n ?? 0);
}

/** The cursor position of a row: its `send_at` at microsecond precision. */
export async function sendAtOf(
  tx: Tx,
  householdId: string,
  userId: string,
  id: string,
): Promise<string | null> {
  const res = await tx.execute<{ s: string }>(sql`select
      to_char(send_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as s
    from notifications where id = ${id} and household_id = ${householdId} and user_id = ${userId}`);
  return res.rows[0]?.s ?? null;
}

/** Marks one of the caller's notifications read (first read wins) and returns it, or null when it is not theirs. */
export async function markRead(
  tx: Tx,
  householdId: string,
  userId: string,
  id: string,
): Promise<Notification | null> {
  const upd = await tx.execute(sql`update notifications set read_at = coalesce(read_at, now())
    where id = ${id} and household_id = ${householdId} and user_id = ${userId} and status <> 'cancelled'`);
  if ((upd.rowCount ?? 0) === 0) return null;
  const res = await tx.execute<NotificationRow>(sql`select ${COLUMNS} from notifications n
    left join notification_deliveries d on d.notification_id = n.id and d.channel = 'email'
    where n.id = ${id} and n.household_id = ${householdId} and n.user_id = ${userId}`);
  const row = res.rows[0];
  return row ? toNotification(row) : null;
}

interface PreferencesRow extends Record<string, unknown> {
  email_enabled: boolean;
  muted_kinds: string[];
  suppressed_at: string | null;
  email_suppressed_reason: "hard_bounce" | "complaint" | null;
}

export async function getPreferences(tx: Tx, userId: string): Promise<NotificationPreferences> {
  const res = await tx.execute<PreferencesRow>(sql`select email_enabled, muted_kinds,
      to_char(email_suppressed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as suppressed_at,
      email_suppressed_reason
    from notification_preferences where user_id = ${userId}`);
  const row = res.rows[0];
  if (!row) return { emailEnabled: true, mutedKinds: [], emailSuppressed: null };
  return {
    emailEnabled: row.email_enabled,
    mutedKinds: row.muted_kinds as NotificationPreferences["mutedKinds"],
    emailSuppressed:
      row.suppressed_at && row.email_suppressed_reason
        ? { reason: row.email_suppressed_reason, at: row.suppressed_at }
        : null,
  };
}

export async function upsertPreferences(
  tx: Tx,
  userId: string,
  change: { emailEnabled?: boolean | undefined; mutedKinds?: readonly string[] | undefined },
): Promise<void> {
  // A Postgres array literal built from validated enum words (drizzle would expand a JS array into a list).
  const kinds = change.mutedKinds ? `{${[...new Set(change.mutedKinds)].join(",")}}` : null;
  // Merge the change into the stored row (or the defaults when there is none yet).
  await tx.execute(sql`insert into notification_preferences (user_id, email_enabled, muted_kinds)
    values (${userId}, ${change.emailEnabled ?? true}, ${kinds ?? "{}"}::text[])
    on conflict (user_id) do update set
      email_enabled = coalesce(${change.emailEnabled ?? null}::boolean, notification_preferences.email_enabled),
      muted_kinds = coalesce(${kinds}::text[], notification_preferences.muted_kinds)`);
}

// ===== Reminder rules: item_id null = the household default =====
interface RuleRow extends Record<string, unknown> {
  offsets_days: number[];
  channels: ReminderRule["channels"];
  also_notify_partner: boolean;
}

function toRule(row: RuleRow): ReminderRule {
  return {
    offsetsDays: row.offsets_days,
    channels: row.channels,
    alsoNotifyPartner: row.also_notify_partner,
  };
}

// Postgres array literals built from validated integers and enum words (drizzle would expand a JS array).
const intArray = (a: readonly number[]) => `{${a.join(",")}}`;
const textArray = (a: readonly string[]) => `{${a.join(",")}}`;

export async function itemExists(tx: Tx, householdId: string, itemId: string): Promise<boolean> {
  const res = await tx.execute(sql`select 1 from recurring_items
    where id = ${itemId} and household_id = ${householdId} and deleted_at is null`);
  return res.rows.length > 0;
}

export async function getRule(
  tx: Tx,
  householdId: string,
  itemId: string | null,
): Promise<ReminderRule | null> {
  const res =
    await tx.execute<RuleRow>(sql`select offsets_days, channels, also_notify_partner from reminder_rules
    where household_id = ${householdId} and ${itemId === null ? sql`item_id is null` : sql`item_id = ${itemId}`}`);
  const row = res.rows[0];
  return row ? toRule(row) : null;
}

export async function upsertRule(
  tx: Tx,
  householdId: string,
  itemId: string | null,
  rule: ReminderRule,
): Promise<ReminderRule> {
  const offsets = intArray(rule.offsetsDays);
  const channels = textArray(rule.channels);
  const target =
    itemId === null
      ? sql`(household_id) where item_id is null`
      : sql`(household_id, item_id) where item_id is not null`;
  const res = await tx.execute<RuleRow>(sql`insert into reminder_rules
      (household_id, item_id, offsets_days, channels, also_notify_partner)
    values (${householdId}, ${itemId}, ${offsets}::int[], ${channels}::text[], ${rule.alsoNotifyPartner})
    on conflict ${target} do update set offsets_days = excluded.offsets_days, channels = excluded.channels,
      also_notify_partner = excluded.also_notify_partner
    returning offsets_days, channels, also_notify_partner`);
  const row = res.rows[0];
  if (!row) throw new Error("reminder rule upsert returned no row");
  return toRule(row);
}

export async function deleteRule(tx: Tx, householdId: string, itemId: string): Promise<void> {
  await tx.execute(
    sql`delete from reminder_rules where household_id = ${householdId} and item_id = ${itemId}`,
  );
}
