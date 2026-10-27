// Rules 2 and 7: the projected end-of-day balance for every day of the window.
import { compareDates, compareStrings, eachDay, parseDate } from "./dates";
import type { PlainDate } from "./dates";
import { assertCents, sumCents } from "./money";
import { resolveOccurrences } from "./occurrences";
import type { ResolvedOccurrence } from "./occurrences";
import type { EngineInput, Runway, RunwayDay, RunwayEvent } from "./types";
import { primaryPaydays } from "./window";

/**
 * Rule 7, with the balance read as the closing balance of its date (QUESTIONS.md Q-006):
 * - skipped occurrences never count;
 * - paid / received ones count on their paid date only if it is after the balance date;
 * - scheduled ones count on their due date if it is on or after the balance date.
 * Returns the date the money moves in the projection, or null if it doesn't count.
 */
export function projectionDate(occ: ResolvedOccurrence, balanceAsOf: PlainDate): PlainDate | null {
  switch (occ.status) {
    case "skipped":
      return null;
    case "paid":
    case "received": {
      const paid = occ.paidOn ?? occ.dueOn;
      return compareDates(paid, balanceAsOf) > 0 ? paid : null;
    }
    case "scheduled":
      return compareDates(occ.dueOn, balanceAsOf) >= 0 ? occ.dueOn : null;
  }
}

function occurrenceEvent(occ: ResolvedOccurrence, date: PlainDate): RunwayEvent {
  const inflow = occ.item.direction === "inflow";
  return {
    kind: inflow ? "income" : "bill",
    sourceId: occ.item.id,
    occurrenceId: occ.occurrenceId,
    name: occ.item.name,
    owner: occ.item.owner,
    amountCents: inflow ? occ.amountCents : -occ.amountCents,
    date: date.toString(),
    scheduledOn: occ.scheduledOn.toString(),
    dueOn: occ.dueOn.toString(),
    status: occ.status,
    isEstimate: occ.isEstimate,
  };
}

/** Items paid through payroll are deducted before pay arrives and never touch the account. */
export function affectsAccount(item: { paidFrom?: "account" | "payroll" }): boolean {
  return (item.paidFrom ?? "account") === "account";
}

/**
 * Goal deposits: one per month on the first primary payday of that month, starting with the next
 * primary payday (rules 10, 16). Returned for [from, to].
 */
function goalTransferEvents(input: EngineInput, from: PlainDate, to: PlainDate): RunwayEvent[] {
  const paydays = primaryPaydays(input, from.with({ day: 1 }), to);
  const firstPerMonth = new Map<string, PlainDate>();
  for (const d of paydays) {
    const month = d.toPlainYearMonth().toString();
    if (!firstPerMonth.has(month)) firstPerMonth.set(month, d);
  }
  const dates = [...firstPerMonth.values()].filter((d) => compareDates(d, from) >= 0);
  const events: RunwayEvent[] = [];
  for (const goal of input.goals) {
    if ((goal.type ?? "savings") !== "savings" || !goal.monthlyCents || goal.savedCents >= goal.targetCents)
      continue;
    for (const d of dates) {
      events.push({
        kind: "goal_transfer",
        sourceId: goal.id,
        occurrenceId: null,
        name: goal.name,
        owner: "both",
        amountCents: -goal.monthlyCents,
        date: d.toString(),
        scheduledOn: d.toString(),
        dueOn: d.toString(),
        status: "planned",
        isEstimate: false,
      });
    }
  }
  return events;
}

function byDateThenSource(a: RunwayEvent, b: RunwayEvent): number {
  return (
    compareStrings(a.date, b.date) ||
    Number(b.amountCents > 0) - Number(a.amountCents > 0) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.sourceId, b.sourceId) ||
    compareStrings(a.scheduledOn, b.scheduledOn)
  );
}

/**
 * Rule 2. Starts from the latest balance, applies events dated after it but before `from` as carried
 * events, then one end-of-day balance per day of [from, to]. Goal transfers on the final payday (`to`)
 * belong to the next window and are listed in `excludedEvents`.
 */
export function projectRunwayDates(input: EngineInput, from: PlainDate, to: PlainDate): Runway {
  const balanceAsOf = parseDate(input.startingBalance.asOf, "startingBalance.asOf");
  const carried: RunwayEvent[] = [];
  const inWindow: RunwayEvent[] = [];
  const place = (event: RunwayEvent, date: PlainDate) => {
    if (compareDates(date, to) > 0) return;
    if (compareDates(date, from) < 0) carried.push(event);
    else inWindow.push(event);
  };

  for (const occ of resolveOccurrences(input, balanceAsOf, to, affectsAccount)) {
    const date = projectionDate(occ, balanceAsOf);
    if (date !== null) place(occurrenceEvent(occ, date), date);
  }

  for (const p of input.plannedExpenses) {
    if ((p.status ?? "planned") !== "planned") continue;
    const due = parseDate(p.dueOn, "plannedExpense.dueOn");
    if (compareDates(due, balanceAsOf) < 0) continue;
    place(
      {
        kind: "planned_expense",
        sourceId: p.id,
        occurrenceId: null,
        name: p.name,
        owner: p.owner,
        amountCents: -p.amountCents,
        date: due.toString(),
        scheduledOn: due.toString(),
        dueOn: due.toString(),
        status: "planned",
        isEstimate: false,
      },
      due,
    );
  }

  const excluded: RunwayEvent[] = [];
  for (const t of goalTransferEvents(input, from, to)) {
    if (t.date === to.toString()) excluded.push(t);
    else inWindow.push(t);
  }

  carried.sort(byDateThenSource);
  inWindow.sort(byDateThenSource);
  excluded.sort(byDateThenSource);

  const startingBalanceCents = input.startingBalance.cents;
  const openingBalanceCents = assertCents(
    startingBalanceCents + sumCents(carried.map((e) => e.amountCents)),
    "opening balance",
  );

  const days: RunwayDay[] = [];
  let balance = openingBalanceCents;
  let i = 0;
  for (const day of eachDay(from, to)) {
    const iso = day.toString();
    const events: RunwayEvent[] = [];
    while (i < inWindow.length && inWindow[i]?.date === iso) {
      const e = inWindow[i] as RunwayEvent;
      events.push(e);
      balance = assertCents(balance + e.amountCents, "runway balance");
      i++;
    }
    days.push({ date: iso, endBalanceCents: balance, events });
  }

  return {
    startingBalanceCents,
    startingBalanceAsOf: balanceAsOf.toString(),
    carriedEvents: carried,
    openingBalanceCents,
    days,
    excludedEvents: excluded,
  };
}
