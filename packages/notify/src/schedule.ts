// When a reminder goes out: 09:00 household-local time on (due date − offset days), as a UTC instant
// (BACKEND_PLAN §7.6). The date arithmetic is on calendar days and the wall-clock time is resolved in the
// household's zone, so the UTC hour follows daylight saving: 09:00 on Nov 1, 2026 is 13:00Z before the US clocks
// go back that morning and 14:00Z after.
import { Temporal } from "@js-temporal/polyfill";

/** Local hour of every reminder. */
export const REMINDER_HOUR = 9;

/** The dedupe window: how late a reminder may still be planned after its time (the planner runs every 15 min). */
export const REMINDER_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * `dueOn` is `YYYY-MM-DD` in the household's zone; the result is an ISO 8601 UTC instant with `Z`.
 * 09:00 exists exactly once on every day in every US zone, so no gap or overlap handling is needed.
 */
export function reminderSendAt(dueOn: string, offsetDays: number, timeZone: string): string {
  if (!Number.isInteger(offsetDays) || offsetDays < 0)
    throw new RangeError("offsetDays must be a whole number >= 0");
  return Temporal.PlainDate.from(dueOn)
    .subtract({ days: offsetDays })
    .toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from({ hour: REMINDER_HOUR }) })
    .toInstant()
    .toString();
}

/** Whole days from `fromIso` to `toIso` (both `YYYY-MM-DD`). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Temporal.PlainDate.from(fromIso).until(Temporal.PlainDate.from(toIso), { largestUnit: "days" }).days;
}

/** The dedupe key for a reminder: (item, rule date, offset, recipient) per DESIGN_SPEC §6 rule 12. */
export function reminderDedupeKey(input: {
  itemId: string;
  scheduledOn: string;
  offsetDays: number;
  userId: string;
}): string {
  return `reminder:${input.itemId}:${input.scheduledOn}:${input.offsetDays}:${input.userId}`;
}

/**
 * Default offsets (days before the due date) when a bill has no rule of its own: 3 and 0 (BACKEND_PLAN §5.2),
 * and 30, 7 and 0 for items billed every 6 months or less often (DESIGN_SPEC §6 rule 11).
 */
export function defaultOffsets(rrule: string): number[] {
  const parts = new Map(
    rrule
      .split(";")
      .map((p) => p.split("=") as [string, string])
      .filter((p) => p.length === 2),
  );
  const freq = parts.get("FREQ");
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const sixMonthsOrLess = freq === "YEARLY" || (freq === "MONTHLY" && interval >= 6);
  return sixMonthsOrLess ? [30, 7, 0] : [3, 0];
}

/**
 * A monthly subscription (category `subscription`, billed every month) gets no default reminders; it is only
 * reminded when the price changes (DESIGN_SPEC §6 rule 11, Q-134). An item-level rule still applies.
 */
export function isMonthlySubscription(rrule: string, category: string): boolean {
  if (category !== "subscription") return false;
  const parts = new Map(
    rrule
      .split(";")
      .map((p) => p.split("=") as [string, string])
      .filter((p) => p.length === 2),
  );
  return parts.get("FREQ") === "MONTHLY" && Number(parts.get("INTERVAL") ?? "1") === 1;
}
