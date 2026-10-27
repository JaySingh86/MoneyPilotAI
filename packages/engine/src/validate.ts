// Input validation at the engine boundary. Errors name the field, never the amount (hard rule 8).
import { assertTimeZone, compareDates, parseDate } from "./dates";
import { EngineError } from "./errors";
import { assertCents } from "./money";
import { validateSchedule } from "./schedule/expand";
import type { EngineInput, ItemInput } from "./types";

function invalid(detail: string): never {
  throw new EngineError("invalid_input", detail);
}

function nonNegativeCents(value: number, field: string): void {
  assertCents(value, field);
  if (value < 0) invalid(`${field} must not be negative`);
}

function validateItem(item: ItemInput): void {
  if (!item.id) invalid("item id is required");
  if (item.direction !== "inflow" && item.direction !== "outflow") invalid(`item ${item.id}: bad direction`);
  validateSchedule(item.schedule);
  const a = item.amount;
  switch (a.type) {
    case "fixed":
      nonNegativeCents(a.cents, `item ${item.id} amount`);
      break;
    case "estimated":
      if (a.historyCents.length === 0) invalid(`item ${item.id}: an estimated amount needs history`);
      a.historyCents.forEach((c) => nonNegativeCents(c, `item ${item.id} history`));
      break;
    case "statement":
      nonNegativeCents(a.lastStatementCents, `item ${item.id} statement`);
      break;
    default:
      invalid(`item ${item.id}: unknown amount type`);
  }
}

/** Throws `EngineError` unless the input is complete and consistent. */
export function validateInput(input: EngineInput): void {
  const asOf = parseDate(input.asOf, "asOf");
  assertTimeZone(input.timezone);
  nonNegativeCents(input.cushionCents, "cushionCents");
  assertCents(input.startingBalance.cents, "startingBalance.cents");
  const balanceAsOf = parseDate(input.startingBalance.asOf, "startingBalance.asOf");
  if (compareDates(balanceAsOf, asOf) > 0) invalid("startingBalance.asOf is after asOf");

  const items = new Map<string, ItemInput>();
  for (const item of input.items) {
    validateItem(item);
    if (items.has(item.id)) invalid(`duplicate item ${item.id}`);
    items.set(item.id, item);
  }
  const primary = items.get(input.primaryIncomeItemId);
  if (!primary || primary.direction !== "inflow") invalid("primaryIncomeItemId must be an income item");

  const seen = new Set<string>();
  for (const occ of input.occurrences) {
    if (!items.has(occ.itemId)) invalid("occurrence for an unknown item");
    const scheduled = parseDate(occ.scheduledOn, "occurrence.scheduledOn").toString();
    const key = `${occ.itemId}|${scheduled}`;
    if (seen.has(key)) invalid(`duplicate occurrence for item ${occ.itemId}`);
    seen.add(key);
    if (occ.dueOn != null) parseDate(occ.dueOn, "occurrence.dueOn");
    if (occ.paidOn != null) parseDate(occ.paidOn, "occurrence.paidOn");
    if (occ.actualAmountCents != null)
      nonNegativeCents(occ.actualAmountCents, "occurrence.actualAmountCents");
  }

  for (const p of input.plannedExpenses) {
    parseDate(p.dueOn, "plannedExpense.dueOn");
    nonNegativeCents(p.amountCents, `planned expense ${p.id}`);
  }
  for (const g of input.goals) {
    nonNegativeCents(g.targetCents, `goal ${g.id} target`);
    nonNegativeCents(g.savedCents, `goal ${g.id} saved`);
    if (g.monthlyCents != null) nonNegativeCents(g.monthlyCents, `goal ${g.id} monthly`);
    if (g.targetDate != null) parseDate(g.targetDate, "goal.targetDate");
  }
}
