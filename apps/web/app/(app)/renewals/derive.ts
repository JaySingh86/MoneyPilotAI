// What the Renewals screen shows per row. Amounts, dates and flags come from the API; this only picks words.
import { money } from "@mp/format";
import type { Plan } from "../../../lib/api/planning-types";
import { daysFrom } from "../../../lib/lists/dates";
import type { RenewalRow } from "../../../lib/lists/hooks";
import { reminderText } from "../bills/derive";
import type { RowStatus } from "../bills/derive";

export const RADAR_DAYS = 90;

export const CATEGORY_LABEL: Readonly<Record<RenewalRow["category"], string>> = {
  insurance: "Insurance",
  subscription: "Subscription",
  membership: "Membership",
  vehicle_home: "Vehicle & home",
};

export const dollars = (cents: number): string => money(cents, { mode: "headline", rounding: "nearest" });

/** "$684" for whole dollars, "$49.99" otherwise (the canvas cards). */
export const compactMoney = (cents: number): string =>
  cents % 100 === 0 ? dollars(cents) : money(cents, { mode: "detail" });

export function frequencyWords(every: RenewalRow["every"]): string {
  if (every.unit === "month")
    return every.n === 1 ? "monthly" : every.n === 12 ? "yearly" : `${every.n} months`;
  return every.n === 1 ? "weekly" : `${every.n} weeks`;
}

/** "a month", "a year", "every 6 months". */
export function costFrequency(every: RenewalRow["every"]): string {
  if (every.unit === "month")
    return every.n === 1 ? "a month" : every.n === 12 ? "a year" : `every ${every.n} months`;
  return every.n === 1 ? "a week" : `every ${every.n} weeks`;
}

function flagged(plan: Plan, row: RenewalRow, code: string): boolean {
  return plan.flags.some((f) => f.code === code && (f.subjectId === row.id || f.subjectId === row.itemId));
}

/** Items that need a decision use the attention card and an attention dot (§5.1). */
export function needsDecision(plan: Plan, row: RenewalRow): boolean {
  return (
    row.priceUp ||
    row.actByKind === "decision" ||
    plan.decisions.some((d) => d.subjectId === row.id || (row.itemId !== null && d.subjectId === row.itemId))
  );
}

export function statusOf(plan: Plan, row: RenewalRow, short: (iso: string) => string): RowStatus {
  if (row.actBy && row.actByKind === "decision")
    return { variant: "attention", text: `Decide by ${short(row.actBy)}` };
  if (row.actBy && row.actByKind === "cancel")
    return { variant: "attention", text: `Cancel by ${short(row.actBy)}?` };
  if (row.priceUp) return { variant: "attention", text: `Up ${dollars(row.annualIncreaseCents)} a year` };
  if (flagged(plan, row, "possible_duplicate")) return { variant: "attention", text: "Possible duplicate" };
  if (
    plan.decisions.some((d) => d.subjectId === row.id || (row.itemId !== null && d.subjectId === row.itemId))
  )
    return { variant: "attention", text: "Due soon" };
  if (row.autoRenews === "no") return { variant: "info", text: "Not automatic" };
  return { variant: "ok", text: "On track" };
}

/** The radar's rows: big renewals inside 90 days (summary ids) plus plan decisions with a deadline inside it. */
export function radarRows(rows: readonly RenewalRow[], ids: readonly string[], today: string): RenewalRow[] {
  return rows.filter((r) => {
    if (ids.includes(r.id)) return true;
    if (r.big || r.decisionBy === null) return false;
    const days = daysFrom(today, r.decisionBy);
    return days >= 0 && days <= RADAR_DAYS;
  });
}

/** The date a radar card and dot are placed at: the decision deadline for plan decisions, else the renewal. */
export function radarDate(r: RenewalRow): string {
  return r.actByKind === "decision" && r.actBy ? r.actBy : r.renewsOn;
}

export function actByText(row: RenewalRow, today: string, short: (iso: string) => string): string {
  if (row.actBy && row.actByKind === "decision") return `Decide by ${short(row.actBy)}`;
  if (row.actBy && row.actByKind === "cancel") return `Cancel by ${short(row.actBy)}`;
  if (row.big && daysFrom(today, row.shopAroundOn) >= 0) return `Shop around by ${short(row.shopAroundOn)}`;
  return "—";
}

export function autoRenewsText(a: RenewalRow["autoRenews"]): string {
  return a === "yes" ? "Yes" : a === "no" ? "No, renew it yourself" : "Rolls over if no choice";
}

export function noteFor(row: RenewalRow): string {
  if (row.priceUp)
    return `The price went up: ${money(row.amountCents, { mode: "detail" })} now, ${dollars(row.annualIncreaseCents)} more a year.`;
  if (row.markedPossiblyUnused)
    return `Marked as possibly unused. Dropping it saves ${money(row.annualCents, { mode: "detail" })} a year.`;
  if (row.autoRenews === "no")
    return `This doesn’t renew on its own. Reminders: ${reminderText(row.reminderOffsetsDays).toLowerCase()}.`;
  if (row.reminderOffsetsDays.length > 0)
    return `Reminders: ${reminderText(row.reminderOffsetsDays).toLowerCase()}.`;
  return "Monthly subscriptions only get a reminder when the price changes.";
}
