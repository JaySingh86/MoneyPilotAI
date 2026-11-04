// What the Bills screen shows per row, from the items, occurrences and the plan's flags. No arithmetic on
// amounts except one difference of two API amounts for "Price up $3"; rules and estimates come from the API.
import { estimateRange, money } from "@mp/format";
import type { Plan } from "../../../lib/api/planning-types";
import type { Item, Occurrence, RenewalRow } from "../../../lib/lists/hooks";

/** The household's default reminder offsets for bills, in days before the due date (rule 12; WP-15, Q-161). */
export const DEFAULT_BILL_REMINDER_OFFSETS: readonly number[] = [3, 0];

export type ChipVariant = "ok" | "income" | "attention" | "info" | "estimate";

export interface RowStatus {
  variant: ChipVariant;
  text: string;
}

export interface BillRow {
  item: Item;
  /** The next scheduled due date, or null when nothing is scheduled. */
  next: string | null;
  occurrenceId: string | null;
  status: RowStatus;
  isPrimaryIncome: boolean;
}

/** The estimate range (rule 6) the plan states for an item, when it has one. */
export function estimateRangeOf(plan: Plan, itemId: string): number | null {
  const d = plan.decisions.find((x) => x.kind === "estimate" && x.subjectId === itemId);
  const range = d?.params.rangeCents;
  return typeof range === "number" ? range : null;
}

export function statusOf(item: Item, plan: Plan, isPrimaryIncome: boolean): RowStatus {
  if (item.direction === "inflow") {
    return isPrimaryIncome ? { variant: "info", text: "Sets payday" } : { variant: "ok", text: "Expected" };
  }
  const flags = plan.flags.filter((f) => f.subjectId === item.id).map((f) => f.code);
  if (flags.includes("price_up")) {
    const before = item.renewal?.previousAmountCents;
    const up = before != null && item.amountCents != null ? item.amountCents - before : null;
    return {
      variant: "attention",
      text: up !== null ? `Price up ${money(up, { mode: "headline", rounding: "nearest" })}` : "Price up",
    };
  }
  if (flags.includes("not_usual_month")) return { variant: "attention", text: "Not usual month" };
  if (flags.includes("possible_duplicate")) return { variant: "attention", text: "Possible duplicate" };
  if (item.amountType !== "fixed" || flags.includes("estimate")) {
    const range = estimateRangeOf(plan, item.id);
    return { variant: "estimate", text: range !== null ? `Estimate ${estimateRange(range)}` : "Estimate" };
  }
  return { variant: "ok", text: "Reminder set" };
}

/** The next scheduled occurrence of each item on or after `today`. */
export function nextOccurrences(occurrences: readonly Occurrence[], today: string): Map<string, Occurrence> {
  const next = new Map<string, Occurrence>();
  for (const o of occurrences) {
    if (o.status !== "scheduled" || o.dueOn < today) continue;
    const current = next.get(o.itemId);
    if (!current || o.dueOn < current.dueOn) next.set(o.itemId, o);
  }
  return next;
}

export function buildRows(
  items: readonly Item[],
  occurrences: readonly Occurrence[],
  plan: Plan,
  primaryIncomeItemId: string | null,
): BillRow[] {
  const next = nextOccurrences(occurrences, plan.asOf);
  return items
    .map((item): BillRow => {
      const occurrence = next.get(item.id);
      const isPrimaryIncome = item.id === primaryIncomeItemId;
      return {
        item,
        next: occurrence?.dueOn ?? null,
        occurrenceId: occurrence?.id ?? null,
        status: statusOf(item, plan, isPrimaryIncome),
        isPrimaryIncome,
      };
    })
    .sort((a, b) => (a.next ?? "9999").localeCompare(b.next ?? "9999") || a.item.id.localeCompare(b.item.id));
}

export type TypeFilter = "all" | "bills" | "income" | "subscriptions" | "estimates";

export const TYPE_TESTS: Readonly<Record<TypeFilter, (i: Item) => boolean>> = {
  all: () => true,
  bills: (i) => i.direction === "outflow",
  income: (i) => i.direction === "inflow",
  subscriptions: (i) => i.kind === "subscription",
  estimates: (i) => i.direction === "outflow" && i.amountType !== "fixed",
};

/** Rule 13: a partner's filter includes their own items plus items owned by Both or Split. */
export function ownerVisible(item: Item, filter: string): boolean {
  return filter === "all" || item.ownerType !== "member" || item.ownerUserId === filter;
}

/** "3 days before and on the due date", "30 and 7 days before, and on the day". */
export function reminderText(offsets: readonly number[]): string {
  const before = offsets.filter((d) => d > 0);
  const onDay = offsets.includes(0);
  if (before.length === 0) return onDay ? "On the due date" : "None";
  const list =
    before.length === 1
      ? String(before[0])
      : `${before.slice(0, -1).join(", ")} and ${before[before.length - 1]}`;
  const days = `${list} ${before.length === 1 && before[0] === 1 ? "day" : "days"} before`;
  if (!onDay) return days;
  return before.length === 1 ? `${days} and on the due date` : `${days}, and on the day`;
}

export function remindersFor(item: Item, renewal: RenewalRow | undefined): string {
  if (item.direction === "inflow") return "None";
  if (renewal && renewal.reminderOffsetsDays.length > 0) return reminderText(renewal.reminderOffsetsDays);
  if (item.kind === "subscription") return "On price changes only";
  return reminderText(DEFAULT_BILL_REMINDER_OFFSETS);
}
