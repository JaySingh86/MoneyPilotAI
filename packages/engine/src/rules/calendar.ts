// Calendar month (DESIGN_SPEC §4.2, §5.1 Calendar, BACKEND_PLAN §7.1): the chips for each day and the
// "{Month} at a glance" totals. Occurrences, planned expenses and goal-transfer reminders.
import { compareDates, compareStrings, eachDay, parseDate, Temporal } from "../dates";
import type { PlainDate } from "../dates";
import { EngineError } from "../errors";
import { sumCents } from "../money";
import { resolveOccurrences } from "../occurrences";
import { affectsAccount } from "../runway";
import type { Cents, EngineInput, FlagCode, IsoDate, OccurrenceStatus, OwnerKey } from "../types";
import { validateInput } from "../validate";
import { primaryPaydays } from "../window";
import { ruleFlags } from "./flags";
import { goalDepositDates } from "./goals";
import { ownerMatches } from "./owners";

export type CalendarEntryKind = "income" | "bill" | "estimate" | "decision" | "planned" | "goal_transfer";

/**
 * Flags that turn a bill chip into a "Needs a decision" chip. This follows the canvas calendar board
 * (Web · Calendar), which draws the streaming price-up (Nov 2), car insurance (Nov 4) and the second music
 * service (Nov 21) as "Needs a decision" chips. Rule 19's list of Overview decision cards is a separate
 * thing: price-up and possible-duplicate are not cards there. The canvas wins (QUESTIONS.md Q-017).
 */
export const DECISION_FLAG_CODES: readonly FlagCode[] = [
  "not_usual_month",
  "price_up",
  "possible_duplicate",
  "overdue",
];

export interface CalendarEntry {
  kind: CalendarEntryKind;
  /** Item, planned expense id, or `goal_transfer` for the combined goal reminder. */
  sourceId: string;
  occurrenceId: string | null;
  name: string;
  owner: OwnerKey;
  /** Signed: income positive, money out negative. */
  amountCents: Cents;
  date: IsoDate;
  status: OccurrenceStatus | "planned";
  isEstimate: boolean;
  flagCodes: FlagCode[];
  /** For `goal_transfer`: the goals whose monthly deposits it reminds about. */
  goalIds: string[];
}

export interface CalendarDay {
  date: IsoDate;
  isPayday: boolean;
  entries: CalendarEntry[];
}

export interface CalendarMonthSummary {
  incomeCents: Cents;
  billsCount: number;
  /** Positive total of bills (estimates and flagged bills included). */
  billsCents: Cents;
  /** Positive total of goal transfers and planned expenses. */
  goalsAndPlannedCents: Cents;
  leftForEverydayCents: Cents;
  estimatesCount: number;
}

export interface CalendarMonth {
  month: string;
  days: CalendarDay[];
  summary: CalendarMonthSummary;
}

const YEAR_MONTH = /^\d{4}-\d{2}$/;

function parseMonth(month: string): PlainDate {
  if (!YEAR_MONTH.test(month)) throw new EngineError("invalid_date", "month must be YYYY-MM");
  try {
    return Temporal.PlainYearMonth.from(month, { overflow: "reject" }).toPlainDate({ day: 1 });
  } catch {
    throw new EngineError("invalid_date", "month is not a real calendar month");
  }
}

function occurrenceEntries(input: EngineInput, first: PlainDate, last: PlainDate): CalendarEntry[] {
  const itemCodes = new Map<string, FlagCode[]>();
  for (const f of ruleFlags(input)) {
    if (!DECISION_FLAG_CODES.includes(f.code) || f.subjectId === null) continue;
    // Item-level flags apply to every occurrence; dated ones to that due date only.
    const key =
      f.code === "price_up" || f.code === "possible_duplicate" ? f.subjectId : `${f.subjectId}|${f.date}`;
    itemCodes.set(key, [...(itemCodes.get(key) ?? []), f.code]);
  }
  return resolveOccurrences(input, first, last, affectsAccount)
    .filter(
      (o) => o.status !== "skipped" && compareDates(o.dueOn, first) >= 0 && compareDates(o.dueOn, last) <= 0,
    )
    .map((o) => {
      const date = o.dueOn.toString();
      const codes = [...(itemCodes.get(o.item.id) ?? []), ...(itemCodes.get(`${o.item.id}|${date}`) ?? [])];
      const inflow = o.item.direction === "inflow";
      const kind: CalendarEntryKind = inflow
        ? "income"
        : codes.length > 0
          ? "decision"
          : o.isEstimate
            ? "estimate"
            : "bill";
      return {
        kind,
        sourceId: o.item.id,
        occurrenceId: o.occurrenceId,
        name: o.item.name,
        owner: o.item.owner,
        amountCents: inflow ? o.amountCents : -o.amountCents,
        date,
        status: o.status,
        isEstimate: o.isEstimate,
        flagCodes: codes,
        goalIds: [],
      };
    });
}

function plannedEntries(input: EngineInput, first: PlainDate, last: PlainDate): CalendarEntry[] {
  return input.plannedExpenses
    .filter((p) => (p.status ?? "planned") === "planned")
    .filter((p) => {
      const d = parseDate(p.dueOn, "plannedExpense.dueOn");
      return compareDates(d, first) >= 0 && compareDates(d, last) <= 0;
    })
    .map((p): CalendarEntry => ({
      kind: "planned",
      sourceId: p.id,
      occurrenceId: null,
      name: p.name,
      owner: p.owner,
      amountCents: -p.amountCents,
      date: parseDate(p.dueOn).toString(),
      status: "planned",
      isEstimate: false,
      flagCodes: [],
      goalIds: [],
    }));
}

/** One combined reminder per deposit date for the goals the runway transfers to (rules 10, 16). */
function goalEntries(input: EngineInput, first: PlainDate, last: PlainDate): CalendarEntry[] {
  const goals = input.goals.filter(
    (g) => (g.type ?? "savings") === "savings" && (g.monthlyCents ?? 0) > 0 && g.savedCents < g.targetCents,
  );
  if (goals.length === 0) return [];
  const out: CalendarEntry[] = [];
  for (const d of goalDepositDates(input)) {
    if (compareDates(d, last) > 0) break;
    if (compareDates(d, first) < 0) continue;
    out.push({
      kind: "goal_transfer",
      sourceId: "goal_transfer",
      occurrenceId: null,
      name: "goal_transfer",
      owner: "both",
      amountCents: -sumCents(goals.map((g) => g.monthlyCents as Cents)),
      date: d.toString(),
      status: "planned",
      isEstimate: false,
      flagCodes: [],
      goalIds: goals.map((g) => g.id),
    });
  }
  return out;
}

function entryOrder(a: CalendarEntry, b: CalendarEntry): number {
  return (
    Number(b.amountCents > 0) - Number(a.amountCents > 0) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.sourceId, b.sourceId)
  );
}

/** The calendar for `month` (`YYYY-MM`). `owner` applies rule 13 to the chips and the totals. */
export function calendarMonth(
  input: EngineInput,
  month: string,
  options: { owner?: OwnerKey | null } = {},
): CalendarMonth {
  validateInput(input);
  const first = parseMonth(month);
  const last = first.add({ months: 1 }).subtract({ days: 1 });
  const entries = [
    ...occurrenceEntries(input, first, last),
    ...plannedEntries(input, first, last),
    ...goalEntries(input, first, last),
  ].filter((e) => ownerMatches(e.owner, options.owner ?? null));

  const paydays = new Set(primaryPaydays(input, first, last).map((d) => d.toString()));
  const days = eachDay(first, last).map((d) => {
    const date = d.toString();
    return {
      date,
      isPayday: paydays.has(date),
      entries: entries.filter((e) => e.date === date).sort(entryOrder),
    };
  });

  const bills = entries.filter((e) => e.kind === "bill" || e.kind === "estimate" || e.kind === "decision");
  const incomeCents = sumCents(entries.filter((e) => e.kind === "income").map((e) => e.amountCents));
  const billsCents = 0 - sumCents(bills.map((e) => e.amountCents));
  const goalsAndPlannedCents =
    0 -
    sumCents(
      entries.filter((e) => e.kind === "planned" || e.kind === "goal_transfer").map((e) => e.amountCents),
    );
  return {
    month: first.toPlainYearMonth().toString(),
    days,
    summary: {
      incomeCents,
      billsCount: bills.length,
      billsCents,
      goalsAndPlannedCents,
      leftForEverydayCents: incomeCents - billsCents - goalsAndPlannedCents,
      estimatesCount: entries.filter((e) => e.isEstimate).length,
    },
  };
}
