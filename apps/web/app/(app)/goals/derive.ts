// Words for goals and the "Planned expenses ahead" rows. Every amount and date is the API's.
import { money } from "@mp/format";
import { monthName, monthYear, shortDate, shortDateNoYear } from "../../../lib/format/dates";
import type { Goal, PlannedExpense, RenewalRow } from "../../../lib/lists/hooks";

export const dollars = (cents: number): string => money(cents, { mode: "headline", rounding: "nearest" });

export const isOk = (status: Goal["progress"]["status"]): boolean =>
  status === "reached" || status === "reach_month" || status === "on_track";

/** "Reached in Oct 2027", "$250 behind", "$380 to set aside", "On track for Mar 1, 2027". */
export function statusText(goal: Pick<Goal, "targetDate" | "progress">, today: string): string {
  const p = goal.progress;
  switch (p.status) {
    case "reached":
      return "Reached";
    case "reach_month":
      return p.reachMonth ? `Reached in ${monthYear(p.reachMonth)}` : "Reached";
    case "no_monthly_amount":
      return "No monthly amount set";
    case "unreachable":
      return "Not reachable at this amount";
    case "on_track":
      return goal.targetDate ? `On track for ${shortDate(goal.targetDate, today)}` : "On track";
    case "behind":
      return `${dollars(p.gapCents ?? 0)} behind`;
    case "to_set_aside":
      return `${dollars(p.gapCents ?? 0)} to set aside`;
  }
}

export const kindLabel = (goal: Pick<Goal, "type">): string =>
  goal.type === "planned_expense" ? "Planned expense" : "Goal";

export function targetLine(goal: Goal, today: string): string {
  const target = money(goal.targetCents, { mode: "headline", rounding: "nearest" });
  return goal.targetDate
    ? `Target ${target} by ${shortDate(goal.targetDate, today)}`
    : `Target ${target} · no deadline`;
}

export function amountsLine(goal: Goal): string {
  const base = `${dollars(goal.savedCents)} of ${dollars(goal.targetCents)}`;
  return goal.targetDate ? `${base} · by ${shortDateNoYear(goal.targetDate)}` : base;
}

export const TONES = { 1: "brand", 2: "partnerA", 3: "partnerB" } as const;

export interface PlannedRow {
  key: string;
  date: string;
  name: string;
  meta: string;
  chip: { variant: "ok" | "attention" | "info"; text: string };
  amountCents: number;
}

/**
 * Planned expenses ahead (§5.1): planned expenses, goals with a target date, and renewals that don't renew
 * themselves, by date.
 */
export function plannedRows(
  planned: readonly PlannedExpense[],
  goals: readonly Goal[],
  renewals: readonly RenewalRow[],
  ownerLabel: (ownerId: string) => string,
  today: string,
): PlannedRow[] {
  const rows: PlannedRow[] = [
    ...planned.map((p): PlannedRow => ({
      key: `p:${p.id}`,
      date: p.dueOn,
      name: p.name,
      meta: `Planned expense · ${ownerLabel(p.ownerUserId ?? p.ownerType)}`,
      chip: { variant: "ok", text: `In ${monthName(p.dueOn.slice(0, 7))}’s plan` },
      amountCents: p.amountCents,
    })),
    ...goals.flatMap((g): PlannedRow[] =>
      g.targetDate
        ? [
            {
              key: `g:${g.id}`,
              date: g.targetDate,
              name: g.name,
              meta:
                g.type === "planned_expense" ? `${dollars(g.savedCents)} set aside` : "Paid from the goal",
              chip:
                g.type === "planned_expense"
                  ? { variant: isOk(g.progress.status) ? "ok" : "attention", text: statusText(g, today) }
                  : { variant: "ok", text: "Goal" },
              amountCents: g.targetCents,
            },
          ]
        : [],
    ),
    ...renewals
      .filter((r) => r.autoRenews === "no")
      .map((r): PlannedRow => ({
        key: `r:${r.id}`,
        date: r.renewsOn,
        name: r.name,
        meta: `From renewals · ${ownerLabel(r.owner)}`,
        chip: { variant: "info", text: "Not automatic" },
        amountCents: r.amountCents,
      })),
  ];
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** "2,400" or "2400.50" to cents, or null. Integer arithmetic only (hard rule 1). */
export function parseDollars(text: string): number | null {
  const match = /^\s*\$?\s*(\d{1,9}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const whole = Number((match[1] ?? "").replace(/,/g, ""));
  const frac = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}
