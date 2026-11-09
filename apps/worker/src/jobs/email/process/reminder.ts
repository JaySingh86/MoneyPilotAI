// The one-off reminder for a price change on a monthly subscription (Q-134, DESIGN_SPEC §6 rule 11).
//
// A monthly subscription gets no default reminders (`isMonthlySubscription`, WP-15); it is reminded when its price
// changes. When a validated email says the price of the matched item went up, the owner (or both members, for a shared
// item) gets ONE reminder for the next charge: at 09:00 local, 3 days before it when that is still ahead, otherwise now.
//
// It is an ordinary `reminder` notification for the next bill, so the dispatcher checks it against the live occurrence
// before sending (paid, moved or removed cancels it) and the household's reminder channels apply. The dedupe key keeps
// it to one per bill and member whatever a retry does, and the planner leaves keys that start with `price_change:` alone.
// The text names the item and carries no amount: numbers shown to people come from the engine (hard rule 4), and this is
// also an email subject.
import { sql } from "drizzle-orm";
import { daysBetween, reminderSendAt } from "@mp/notify";
import type { Tx } from "@mp/db";
import { Temporal } from "@js-temporal/polyfill";
import type { ItemContext } from "./analyze";

/** How many days before the charge the reminder goes out, when there is time. */
export const PRICE_CHANGE_OFFSET_DAYS = 3;

export interface PriceChangeReminder {
  userId: string;
  itemId: string;
  scheduledOn: string;
  dueOn: string;
  offsetDays: number;
  sendAt: string;
  dedupeKey: string;
  title: string;
  body: string;
  deepLink: string;
}

export const priceChangeDedupeKey = (itemId: string, scheduledOn: string, userId: string): string =>
  `price_change:${itemId}:${scheduledOn}:${userId}`;

/** Pure. No reminder when the item has no upcoming bill or nobody in the household owns it any more. */
export function planPriceChangeReminders(input: {
  item: Pick<ItemContext, "id" | "name" | "ownerType" | "ownerUserId" | "scheduled">;
  members: readonly string[];
  timezone: string;
  nowIso: string;
  /** Household-local today, `YYYY-MM-DD`. */
  today: string;
}): PriceChangeReminder[] {
  const next = input.item.scheduled[0];
  if (!next) return [];
  const recipients =
    input.item.ownerType === "member"
      ? input.item.ownerUserId !== null && input.members.includes(input.item.ownerUserId)
        ? [input.item.ownerUserId]
        : []
      : [...input.members];
  const daysAway = Math.max(0, daysBetween(input.today, next.dueOn));
  const offsetDays = Math.min(PRICE_CHANGE_OFFSET_DAYS, daysAway);
  const planned = reminderSendAt(next.dueOn, offsetDays, input.timezone);
  // 09:00 three days ahead when that is still to come, otherwise right away: the price already changed.
  const sendAt =
    Date.parse(planned) >= Date.parse(input.nowIso)
      ? planned
      : Temporal.Instant.from(input.nowIso).toString({ smallestUnit: "second" });
  return recipients.map((userId) => ({
    userId,
    itemId: input.item.id,
    scheduledOn: next.scheduledOn,
    dueOn: next.dueOn,
    offsetDays,
    sendAt,
    dedupeKey: priceChangeDedupeKey(input.item.id, next.scheduledOn, userId),
    title: `${input.item.name}: the price is changing`,
    body: "A message from the provider says the price is going up. Look over the new price in MoneyPilot before the next charge.",
    deepLink: `/bills?item=${input.item.id}`,
  }));
}

/** Idempotent (the dedupe key). Returns how many reminders were new. */
export async function insertPriceChangeReminders(
  tx: Tx,
  householdId: string,
  reminders: readonly PriceChangeReminder[],
): Promise<number> {
  let created = 0;
  for (const r of reminders) {
    const res = await tx.execute(sql`insert into notifications
        (id, household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at, item_id, scheduled_on,
         offset_days, due_on)
      values (${crypto.randomUUID()}, ${householdId}, ${r.userId}, 'reminder', ${r.dedupeKey}, ${r.title}, ${r.body},
        ${r.deepLink}, ${r.sendAt}::timestamptz, ${r.itemId}, ${r.scheduledOn}::date, ${r.offsetDays}, ${r.dueOn}::date)
      on conflict (household_id, dedupe_key) do nothing`);
    created += res.rowCount ?? 0;
  }
  return created;
}
