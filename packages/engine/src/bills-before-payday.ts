// "Bills before payday" (DESIGN_SPEC §5.1 KPI tile): money going out that is due from today up to, but
// not on, the payday. Includes planned expenses (the shortfall scenario's itemsBeforePayday counts the car
// repair) and paid occurrences that are still due in the window; skipped ones and payroll deductions are
// left out. See QUESTIONS.md Q-008.
import { compareDates, parseDate } from "./dates";
import type { PlainDate } from "./dates";
import { assertCents } from "./money";
import { resolveOccurrences } from "./occurrences";
import { affectsAccount } from "./runway";
import type { BillsBeforePayday, Cents, EngineInput, OwnerKey } from "./types";

export function billsBeforePaydayDates(
  input: EngineInput,
  from: PlainDate,
  payday: PlainDate,
): BillsBeforePayday {
  const byOwner: Record<OwnerKey, Cents> = {};
  let count = 0;
  let totalCents = 0;
  const add = (owner: OwnerKey, cents: Cents) => {
    count++;
    totalCents = assertCents(totalCents + cents, "bills before payday");
    byOwner[owner] = assertCents((byOwner[owner] ?? 0) + cents, "bills before payday");
  };
  if (compareDates(payday, from) <= 0) return { count, totalCents, byOwner };
  const lastDay = payday.subtract({ days: 1 });

  for (const occ of resolveOccurrences(
    input,
    from,
    lastDay,
    (i) => i.direction === "outflow" && affectsAccount(i),
  )) {
    if (occ.status === "skipped") continue;
    if (compareDates(occ.dueOn, from) < 0 || compareDates(occ.dueOn, lastDay) > 0) continue;
    add(occ.item.owner, occ.amountCents);
  }
  for (const p of input.plannedExpenses) {
    if ((p.status ?? "planned") !== "planned") continue;
    const due = parseDate(p.dueOn, "plannedExpense.dueOn");
    if (compareDates(due, from) < 0 || compareDates(due, lastDay) > 0) continue;
    add(p.owner, p.amountCents);
  }
  return { count, totalCents, byOwner };
}
