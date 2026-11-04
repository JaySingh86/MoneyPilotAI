// The sentence under each item in the selected-day panel. Amounts and dates come from the API entry;
// the words are fixed copy (AI-written explanations arrive with WP-27).
import { money } from "@mp/format";
import type { CalendarEntryDto, CalendarEntryKind } from "../../../lib/api/planning-types";

const dollars = (cents: number) => money(cents, { mode: "headline", rounding: "nearest" });

/** "3 days before and on the due date" from reminder offsets (days before the due date). */
export function reminderText(offsets: readonly number[]): string {
  const before = [...offsets].filter((d) => d > 0).sort((a, b) => b - a);
  const onDay = offsets.includes(0);
  const parts = before.map((d) => `${d} ${d === 1 ? "day" : "days"} before`);
  if (onDay) parts.push("on the due date");
  if (parts.length === 0) return "No reminder is set.";
  return `Reminder ${parts.join(" and ")}.`;
}

export function entryNote(entry: CalendarEntryDto, offsets: readonly number[]): string {
  switch (entry.kind) {
    case "income":
      return `${entry.scheduleLabel ? `${entry.scheduleLabel}. ` : ""}Expected, not yet confirmed.`;
    case "estimate": {
      const e = entry.estimate;
      if (e && e.historyCents.length > 0 && e.minCents !== null && e.maxCents !== null) {
        return `Estimate from your last ${e.historyCents.length} bills (${dollars(e.minCents)}–${dollars(e.maxCents)}). Enter the actual amount when it arrives.`;
      }
      return "Estimate from last month’s statement. Enter the statement balance when it posts.";
    }
    case "decision": {
      if (entry.priceChange) {
        return `Price went from ${money(entry.priceChange.previousCents, { mode: "detail" })} to ${money(entry.priceChange.currentCents, { mode: "detail" })}. Keep, downgrade or cancel?`;
      }
      if (entry.everyMonths !== null) {
        return `This bill comes every ${entry.everyMonths} months, so it isn’t in your usual month.`;
      }
      if (entry.flagCodes.includes("possible_duplicate")) {
        return "Looks like it overlaps with another plan in the same category. Review together?";
      }
      return "Needs a decision.";
    }
    case "planned":
      return "Planned expense. Counted in this month’s plan.";
    case "goal_transfer": {
      const deposits = entry.goalDeposits.map((g) => `${dollars(g.amountCents)} to ${g.name}`).join(" and ");
      return `Reminder to move ${deposits}. You make the transfer yourselves.`;
    }
    case "bill":
      return `${entry.scheduleLabel && entry.scheduleLabel !== "Monthly" ? `${entry.scheduleLabel}. ` : ""}${reminderText(offsets)}`;
  }
}

export const KIND_LABEL: Record<CalendarEntryKind, string> = {
  income: "Income",
  bill: "Bill",
  estimate: "Estimate",
  decision: "Needs a decision",
  planned: "Planned",
  goal_transfer: "Planned",
};
