// Resolves the occurrences of each item between two dates: materialized rows where they exist,
// otherwise derived from the schedule and weekend rule (BACKEND_PLAN §7.1, ADR-006).
import { compareDates, compareStrings, parseDate } from "./dates";
import type { PlainDate } from "./dates";
import { divRoundHalfUp, sumCents } from "./money";
import { expandSchedule } from "./schedule/expand";
import { applyWeekendRule } from "./schedule/weekend";
import type { Cents, EngineInput, ItemInput, OccurrenceInput, OccurrenceStatus } from "./types";

export interface ResolvedOccurrence {
  item: ItemInput;
  occurrenceId: string | null;
  scheduledOn: PlainDate;
  dueOn: PlainDate;
  status: OccurrenceStatus;
  paidOn: PlainDate | null;
  /** Unsigned amount: the actual if known, else the item amount or estimate. */
  amountCents: Cents;
  isEstimate: boolean;
}

/** Weekend shifts are at most a few days; widen the expansion so shifted dates near the edges are found. */
const SHIFT_MARGIN_DAYS = 7;

/** The item's planned amount: fixed, the mean of the last 3 amounts (rule 6), or the last statement. */
export function itemAmount(item: ItemInput): { cents: Cents; isEstimate: boolean } {
  const a = item.amount;
  switch (a.type) {
    case "fixed":
      return { cents: a.cents, isEstimate: false };
    case "estimated": {
      const last3 = a.historyCents.slice(-3);
      return { cents: divRoundHalfUp(sumCents(last3), last3.length), isEstimate: true };
    }
    case "statement":
      return { cents: a.lastStatementCents, isEstimate: true };
  }
}

function resolve(
  item: ItemInput,
  scheduledOn: PlainDate,
  row: OccurrenceInput | undefined,
): ResolvedOccurrence {
  const planned = itemAmount(item);
  const actual = row?.actualAmountCents;
  return {
    item,
    occurrenceId: row?.id ?? null,
    scheduledOn,
    dueOn:
      row?.dueOn != null ? parseDate(row.dueOn) : applyWeekendRule(scheduledOn, item.weekendRule ?? "none"),
    status: row?.status ?? "scheduled",
    paidOn: row?.paidOn != null ? parseDate(row.paidOn) : null,
    amountCents: actual != null ? actual : planned.cents,
    isEstimate: actual != null ? false : planned.isEstimate,
  };
}

function inRange(d: PlainDate, from: PlainDate, to: PlainDate): boolean {
  return compareDates(d, from) >= 0 && compareDates(d, to) <= 0;
}

/**
 * Every occurrence whose due date, or paid date, falls in [from, to], sorted by due date then item id.
 * Materialized rows win over the schedule. Paused, ended or pending items project nothing: only their
 * paid or received rows remain (money that already moved).
 */
export function resolveOccurrences(
  input: EngineInput,
  from: PlainDate,
  to: PlainDate,
  itemFilter: (item: ItemInput) => boolean = () => true,
): ResolvedOccurrence[] {
  const rowsByItem = new Map<string, Map<string, OccurrenceInput>>();
  for (const row of input.occurrences) {
    const key = parseDate(row.scheduledOn).toString();
    const rows = rowsByItem.get(row.itemId) ?? new Map<string, OccurrenceInput>();
    rows.set(key, row);
    rowsByItem.set(row.itemId, rows);
  }

  const out: ResolvedOccurrence[] = [];
  const keep = (occ: ResolvedOccurrence) => {
    if (inRange(occ.dueOn, from, to) || (occ.paidOn !== null && inRange(occ.paidOn, from, to))) out.push(occ);
  };

  for (const item of input.items) {
    if (!itemFilter(item)) continue;
    const rows = rowsByItem.get(item.id) ?? new Map<string, OccurrenceInput>();
    const active = (item.status ?? "active") === "active";
    for (const [scheduledOn, row] of rows) {
      const status = row.status ?? "scheduled";
      if (active || status === "paid" || status === "received")
        keep(resolve(item, parseDate(scheduledOn), row));
    }
    if (!active) continue;
    const dates = expandSchedule(
      item.schedule,
      from.subtract({ days: SHIFT_MARGIN_DAYS }),
      to.add({ days: SHIFT_MARGIN_DAYS }),
    );
    for (const d of dates) {
      if (!rows.has(d.toString())) keep(resolve(item, d, undefined));
    }
  }

  return out.sort(
    (a, b) =>
      compareDates(a.dueOn, b.dueOn) ||
      compareStrings(a.item.id, b.item.id) ||
      compareDates(a.scheduledOn, b.scheduledOn),
  );
}
