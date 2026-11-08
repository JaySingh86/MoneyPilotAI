// Job `reminders.plan` (BACKEND_PLAN §7.6, §9; ARCHITECTURE §4.4): every 15 minutes (the sweep fans out one job
// per household) and on an occurrence change. It RECONCILES a household's reminder notifications with what the
// calendar says now:
//   * every upcoming bill occurrence × its offsets × its recipients should have exactly one row, at 09:00
//     household-local time (`reminderSendAt`), keyed (item, rule date, offset, recipient) so running twice adds
//     nothing (DESIGN_SPEC §6 rule 12);
//   * a row whose occurrence moved is updated in place (same key, new time and text), and one that was
//     cancelled earlier comes back if the occurrence is scheduled again (an undone "paid");
//   * a scheduled row with no matching occurrence any more (paid, skipped, deleted, item paused or removed, rule
//     changed) is cancelled. Rows already sent or failed are history and are never touched.
// The payload is a household id only; titles and bodies are built inside the job from the database.
import { z } from "zod";
import { sql } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import { householdToday, type Tx, type WorkerDb } from "@mp/db";
import { date, money, relative } from "@mp/format";
import { REMINDER_GRACE_MS, defaultOffsets, isMonthlySubscription, reminderDedupeKey, reminderSendAt } from "@mp/notify";
import type { JobSender } from "../plan/recompute";

export const REMINDERS_PLAN_QUEUE = "reminders.plan";
export const REMINDERS_SWEEP_QUEUE = "reminders.sweep";
/** Every 15 minutes. */
export const REMINDERS_SWEEP_CRON = "*/15 * * * *";
/** Occurrences due within this many days are planned (ARCHITECTURE §4.4). */
export const PLAN_HORIZON_DAYS = 35;

/** Queue settings: one queued job per household, 5 attempts with backoff (BACKEND_PLAN §9). */
export const REMINDERS_PLAN_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
} as const;

export const RemindersPlanJob = z.object({ householdId: z.uuid() });
export type RemindersPlanJob = z.infer<typeof RemindersPlanJob>;

export function remindersPlanSingletonKey(job: RemindersPlanJob): string {
  return `${REMINDERS_PLAN_QUEUE}:${job.householdId}`;
}

/** Enqueue a re-plan after an occurrence is paid, moved or deleted. Returns null when one is already queued. */
export async function enqueueRemindersPlan(sender: JobSender, householdId: string): Promise<string | null> {
  const job = RemindersPlanJob.parse({ householdId });
  return sender.send(REMINDERS_PLAN_QUEUE, job, { singletonKey: remindersPlanSingletonKey(job) });
}

export interface RemindersSweepDeps {
  db: WorkerDb;
  sender: JobSender;
}

/** The 15-minute trigger: one `reminders.plan` job per household. */
export async function handleRemindersSweep(
  deps: RemindersSweepDeps,
): Promise<{ households: number; enqueued: number }> {
  const ids = await deps.db.listHouseholdIds();
  let enqueued = 0;
  for (const householdId of ids) {
    if ((await enqueueRemindersPlan(deps.sender, householdId)) !== null) enqueued++;
  }
  return { households: ids.length, enqueued };
}

export interface RemindersPlanDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

export interface PlanResult {
  created: number;
  updated: number;
  cancelled: number;
}

export async function handleRemindersPlan(deps: RemindersPlanDeps, data: unknown): Promise<PlanResult> {
  const job = RemindersPlanJob.parse(data);
  return deps.db.withJobTx(job.householdId, (tx) => planReminders(tx, job.householdId, deps.now()));
}

interface OccurrenceRow extends Record<string, unknown> {
  item_id: string;
  scheduled_on: string;
  due_on: string;
  actual_amount_cents: string | null;
  name: string;
  rrule: string;
  category: string;
  amount_cents: string | null;
  amount_type: "fixed" | "estimated" | "statement";
  owner_type: "member" | "both" | "split";
  owner_user_id: string | null;
}

interface RuleRow extends Record<string, unknown> {
  item_id: string | null;
  offsets_days: number[];
  also_notify_partner: boolean;
}

interface Desired {
  key: string;
  userId: string;
  itemId: string;
  scheduledOn: string;
  offsetDays: number;
  dueOn: string;
  sendAt: string;
  title: string;
  body: string;
  deepLink: string;
}

const UPSERT_CHUNK = 200;

/** "Rent is due in 3 days". No amount: this is also the email subject (BACKEND_PLAN §7.6). */
export function reminderTitle(name: string, offsetDays: number): string {
  return `${name} is due ${relative(offsetDays)}`;
}

/** "Due Fri, Nov 6 · $2,150.00. Mark it as paid in MoneyPilot once you have paid it." */
export function reminderBody(input: {
  dueOn: string;
  today: string;
  amountCents: number | null;
  estimated: boolean;
}): string {
  const when = date(Temporal.PlainDate.from(input.dueOn), {
    relativeTo: Temporal.PlainDate.from(input.today),
    weekday: true,
  });
  const amount =
    input.amountCents === null
      ? ""
      : ` · ${money(input.amountCents, { mode: input.estimated ? "estimate" : "detail" })}`;
  return `Due ${when}${amount}. Mark it as paid in MoneyPilot once you have paid it.`;
}

export async function planReminders(tx: Tx, householdId: string, nowIso: string): Promise<PlanResult> {
  const hh = await tx.execute<{ timezone: string }>(
    sql`select timezone from households where id = ${householdId}`,
  );
  const timezone = hh.rows[0]?.timezone;
  if (!timezone) return { created: 0, updated: 0, cancelled: 0 }; // household deleted since the job was queued
  const today = householdToday(nowIso, timezone);
  const horizon = Temporal.PlainDate.from(today).add({ days: PLAN_HORIZON_DAYS }).toString();
  const oldestSendMs = Date.parse(nowIso) - REMINDER_GRACE_MS;

  const members = (
    await tx.execute<{ user_id: string }>(sql`select user_id from household_members
      where household_id = ${householdId} and left_at is null order by joined_at`)
  ).rows.map((r) => r.user_id);
  const rules = (
    await tx.execute<RuleRow>(sql`select item_id, offsets_days, also_notify_partner from reminder_rules
      where household_id = ${householdId}`)
  ).rows;
  const defaultRule = rules.find((r) => r.item_id === null);
  const ruleByItem = new Map(rules.filter((r) => r.item_id !== null).map((r) => [r.item_id as string, r]));

  const occurrences = (
    await tx.execute<OccurrenceRow>(sql`select o.item_id, o.scheduled_on::text as scheduled_on, o.due_on::text as due_on,
        o.actual_amount_cents::text as actual_amount_cents, i.name, i.rrule, i.category, i.amount_cents::text as amount_cents,
        i.amount_type, i.owner_type, i.owner_user_id
      from occurrences o
      join recurring_items i on i.id = o.item_id and i.household_id = o.household_id
      where o.household_id = ${householdId} and o.status = 'scheduled'
        and o.due_on between ${today}::date and ${horizon}::date
        and i.direction = 'outflow' and i.status = 'active' and i.deleted_at is null
      order by o.due_on, o.item_id`)
  ).rows;

  const desired = new Map<string, Desired>();
  for (const o of occurrences) {
    const itemRule = ruleByItem.get(o.item_id);
    // Monthly subscriptions are reminded only on a price change (Q-134); the household default doesn't cover them.
    if (!itemRule && isMonthlySubscription(o.rrule, o.category)) continue;
    const rule = itemRule ?? defaultRule;
    const offsets = rule?.offsets_days ?? defaultOffsets(o.rrule);
    const owner =
      o.owner_type === "member" && o.owner_user_id && members.includes(o.owner_user_id)
        ? [o.owner_user_id]
        : o.owner_type === "member"
          ? [] // the owner left the household: nobody to remind
          : members;
    const recipients = rule?.also_notify_partner ? members : owner;
    const cents = o.actual_amount_cents ?? o.amount_cents;
    const amountCents = cents === null ? null : Number(cents);
    for (const offsetDays of new Set(offsets)) {
      const sendAt = reminderSendAt(o.due_on, offsetDays, timezone);
      if (Date.parse(sendAt) < oldestSendMs) continue; // too late to be useful; the next offset still comes
      const title = reminderTitle(o.name, offsetDays);
      const body = reminderBody({
        dueOn: o.due_on,
        today,
        amountCents,
        estimated: o.actual_amount_cents === null && o.amount_type !== "fixed",
      });
      for (const userId of recipients) {
        const key = reminderDedupeKey({ itemId: o.item_id, scheduledOn: o.scheduled_on, offsetDays, userId });
        desired.set(key, {
          key,
          userId,
          itemId: o.item_id,
          scheduledOn: o.scheduled_on,
          offsetDays,
          dueOn: o.due_on,
          sendAt,
          title,
          body,
          deepLink: `/bills?item=${o.item_id}`,
        });
      }
    }
  }

  const rows = [...desired.values()];
  let created = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const values = sql.join(
      chunk.map(
        (
          d,
        ) => sql`(${crypto.randomUUID()}, ${householdId}, ${d.userId}, 'reminder', ${d.key}, ${d.title}, ${d.body},
          ${d.deepLink}, ${d.sendAt}::timestamptz, ${d.itemId}, ${d.scheduledOn}::date, ${d.offsetDays}, ${d.dueOn}::date)`,
      ),
      sql`, `,
    );
    // Insert new rows; revive a cancelled one; move/refresh a scheduled one only when something changed.
    // A sent or failed row is history and stays as it is.
    const res = await tx.execute<{ inserted: boolean }>(sql`insert into notifications
        (id, household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at, item_id, scheduled_on, offset_days, due_on)
      values ${values}
      on conflict (household_id, dedupe_key) do update set
        send_at = excluded.send_at, attempt_at = null, title = excluded.title, body = excluded.body,
        deep_link = excluded.deep_link, due_on = excluded.due_on, status = 'scheduled'
      where notifications.status = 'cancelled'
         or (notifications.status = 'scheduled'
             and (notifications.send_at, notifications.title, notifications.body, notifications.due_on)
                 is distinct from (excluded.send_at, excluded.title, excluded.body, excluded.due_on))
      returning (xmax = 0) as inserted`);
    for (const r of res.rows) {
      if (r.inserted) created++;
      else updated++;
    }
  }

  // Cancel what the calendar no longer asks for.
  const keep = JSON.stringify(rows.map((d) => d.key));
  const cancelled = await tx.execute(sql`update notifications set status = 'cancelled'
    where household_id = ${householdId} and kind = 'reminder' and status = 'scheduled'
      and dedupe_key <> all (array(select jsonb_array_elements_text(${keep}::jsonb)))`);
  return { created, updated, cancelled: cancelled.rowCount ?? 0 };
}
