// Applying an approved proposal (BACKEND_PLAN §7.3 step 3 and 4; ARCHITECTURE §4.5). The payload is
// re-validated against the current rows first: if the data it was based on changed, the proposal is no
// longer valid and the caller marks it `superseded`. All checks run before any write, so a `Superseded`
// outcome leaves nothing half applied. The change is credited to the proposer, like the direct edit they
// asked for; the approver is recorded on the proposal and in the audit log by the caller.
import { sql } from "drizzle-orm";
import type { Item, PlannedExpense, ProposalPayload } from "@mp/contracts";
import type { Tx } from "@mp/db";
import { shortfallOptions, type ShortfallOption } from "@mp/engine";
import {
  applyItemDelete,
  applyItemPatch,
  applyOccurrencePatch,
  applyPlannedDelete,
  applyPlannedPatch,
  todayFor,
  type ChangeActor,
  type ChangeDeps,
} from "../items/changes";
import * as itemsRepo from "../items/repo";
import {
  applyGoalDelete,
  applyGoalMonthly,
  applyGoalStatus,
  applyGoalTarget,
  eventDelta,
  recordGoalEvent,
} from "../goals/changes";
import { loadPlanInput } from "../goals/load-input";
import * as goalsRepo from "../goals/repo";

/** The data the proposal was based on has changed; `note` says what, without amounts. */
export class Superseded extends Error {
  constructor(readonly note: string) {
    super(note);
    this.name = "Superseded";
  }
}

/** Key order independent JSON, to compare a stored snapshot with a current value. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function unchanged(before: Record<string, unknown>, current: object, keys: readonly string[]): boolean {
  const now = current as Record<string, unknown>;
  return keys.filter((k) => k in before).every((k) => canonical(before[k]) === canonical(now[k] ?? null));
}

/** The fields whose stored value a proposed change depends on. */
const ITEM_GUARDED = ["ownerType", "ownerUserId", "status", "schedule", "weekendRule"] as const;
const PLANNED_GUARDED = ["ownerType", "ownerUserId", "dueOn"] as const;

export interface ApplyContext {
  tx: Tx;
  deps: ChangeDeps;
  householdId: string;
  proposerId: string;
  /** The signed-in member who approved. */
  approverId: string;
}

async function item(c: ApplyContext, id: string, ownerUserId: string | null): Promise<Item> {
  const current = await itemsRepo.getItem(c.tx, c.householdId, id, true);
  if (!current) throw new Superseded("The item no longer exists.");
  if (current.ownerUserId !== ownerUserId) throw new Superseded("The item has a different owner now.");
  return current;
}

async function planned(c: ApplyContext, id: string, ownerUserId: string | null): Promise<PlannedExpense> {
  const current = await itemsRepo.getPlanned(c.tx, c.householdId, id);
  if (!current) throw new Superseded("The planned expense no longer exists.");
  if (current.ownerUserId !== ownerUserId) {
    throw new Superseded("The planned expense has a different owner now.");
  }
  return current;
}

async function occurrence(c: ApplyContext, id: string, ownerUserId: string | null, dueOn: string) {
  const found = await itemsRepo.getOccurrence(c.tx, c.householdId, id);
  if (!found) throw new Superseded("The bill no longer exists.");
  if (found.ownerUserId !== ownerUserId) throw new Superseded("The bill has a different owner now.");
  if (found.occurrence.status !== "scheduled" || found.occurrence.dueOn !== dueOn) {
    throw new Superseded("The bill changed since it was proposed.");
  }
  return found;
}

/** The engine's current shortfall option of this kind, or null if the plan no longer has it. */
async function currentOption<K extends ShortfallOption["kind"]>(
  c: ApplyContext,
  kind: K,
): Promise<Extract<ShortfallOption, { kind: K }> | null> {
  const input = await loadPlanInput(c.tx, c.householdId, c.deps.now(), { requireBalance: true });
  const found = shortfallOptions(input).find((o) => o.kind === kind);
  return (found as Extract<ShortfallOption, { kind: K }> | undefined) ?? null;
}

export async function applyPayload(c: ApplyContext, payload: ProposalPayload): Promise<void> {
  const a: ChangeActor = { householdId: c.householdId, userId: c.proposerId, auditUserId: c.approverId };
  switch (payload.type) {
    case "goal_monthly": {
      const goal = await goalsRepo.getGoal(c.tx, c.householdId, payload.goalId, true);
      if (!goal) throw new Superseded("The goal no longer exists.");
      if (goal.monthlyCents !== payload.fromMonthlyCents) throw new Superseded("The goal changed.");
      await applyGoalMonthly(c.tx, a, goal, payload.toMonthlyCents);
      return;
    }
    case "goal_delete": {
      const goal = await goalsRepo.getGoal(c.tx, c.householdId, payload.goalId, true);
      if (!goal) throw new Superseded("The goal no longer exists.");
      await applyGoalDelete(c.tx, a, goal);
      return;
    }
    case "goal_status": {
      const goal = await goalsRepo.getGoal(c.tx, c.householdId, payload.goalId, true);
      if (!goal) throw new Superseded("The goal no longer exists.");
      if (goal.status !== payload.fromStatus || goal.monthlyCents !== payload.monthlyCents) {
        throw new Superseded("The goal changed.");
      }
      await applyGoalStatus(c.tx, a, goal, payload.toStatus);
      return;
    }
    case "goal_target": {
      const goal = await goalsRepo.getGoal(c.tx, c.householdId, payload.goalId, true);
      if (!goal) throw new Superseded("The goal no longer exists.");
      if (goal.targetCents !== payload.fromTargetCents || goal.monthlyCents !== payload.monthlyCents) {
        throw new Superseded("The goal changed.");
      }
      await applyGoalTarget(c.tx, a, goal, payload.toTargetCents);
      return;
    }
    case "goal_withdrawal": {
      const goal = await goalsRepo.getGoal(c.tx, c.householdId, payload.goalId, true);
      if (!goal) throw new Superseded("The goal no longer exists.");
      if (goal.savedCents + eventDelta(payload.kind, payload.amountCents) < 0) {
        throw new Superseded("The goal holds less than that now.");
      }
      await recordGoalEvent(c.tx, a, goal, {
        kind: payload.kind,
        amountCents: payload.amountCents,
        occurredOn: payload.occurredOn,
        note: payload.note,
      });
      return;
    }
    case "shortfall_move_from_fund": {
      const option = await currentOption(c, "move_from_emergency_fund");
      if (!option || option.goalId !== payload.goalId || option.amountCents !== payload.amountCents) {
        throw new Superseded("The shortfall changed.");
      }
      const goal = await goalsRepo.getGoal(c.tx, c.householdId, payload.goalId, true);
      if (!goal || goal.savedCents < payload.amountCents) throw new Superseded("The fund changed.");
      await recordGoalEvent(c.tx, a, goal, {
        kind: "withdrawal",
        amountCents: payload.amountCents,
        occurredOn: await todayFor(c.tx, c.deps, c.householdId),
        note: "Moved to cover a shortfall",
      });
      return;
    }
    case "shortfall_split_expense": {
      const option = await currentOption(c, "split_expense");
      if (
        !option ||
        option.plannedExpenseId !== payload.plannedExpenseId ||
        option.amountNowCents !== payload.amountNowCents ||
        option.afterPaydayOn !== payload.laterOn
      ) {
        throw new Superseded("The shortfall changed.");
      }
      const expense = await itemsRepo.getPlanned(c.tx, c.householdId, payload.plannedExpenseId);
      if (!expense || expense.amountCents !== payload.amountCents) {
        throw new Superseded("The planned expense changed.");
      }
      await applyPlannedPatch(c.tx, a, expense, { amountCents: payload.amountNowCents });
      await itemsRepo.insertPlanned(c.tx, c.householdId, c.approverId, {
        name: `${expense.name} (rest)`.slice(0, 80),
        amountCents: payload.amountCents - payload.amountNowCents,
        dueOn: payload.laterOn,
        ownerType: expense.ownerType,
        ownerUserId: expense.ownerUserId,
        goalId: expense.goalId,
        status: "planned",
      });
      return;
    }
    case "shortfall_move_bill": {
      const option = await currentOption(c, "move_bill_to_payday");
      if (
        !option ||
        option.itemId !== payload.itemId ||
        option.scheduledOn !== payload.scheduledOn ||
        option.toDate !== payload.toDate
      ) {
        throw new Superseded("The shortfall changed.");
      }
      const res = await c.tx.execute<{ id: string }>(sql`select id from occurrences
        where household_id = ${c.householdId} and item_id = ${payload.itemId}
          and scheduled_on = ${payload.scheduledOn}::date`);
      const id = res.rows[0]?.id;
      const found = id ? await itemsRepo.getOccurrence(c.tx, c.householdId, id) : null;
      if (!found || found.occurrence.status !== "scheduled") throw new Superseded("The bill changed.");
      await applyOccurrencePatch(c.tx, c.deps, a, found, { dueOn: payload.toDate });
      return;
    }
    case "item_delete": {
      await applyItemDelete(c.tx, c.deps, a, await item(c, payload.itemId, payload.ownerUserId));
      return;
    }
    case "item_patch": {
      const current = await item(c, payload.itemId, payload.ownerUserId);
      if (!unchanged(payload.before, current, ITEM_GUARDED)) {
        throw new Superseded("The item changed since it was proposed.");
      }
      await applyItemPatch(c.tx, c.deps, a, current, payload.changes);
      return;
    }
    case "occurrence_move": {
      const found = await occurrence(c, payload.occurrenceId, payload.ownerUserId, payload.fromDueOn);
      await applyOccurrencePatch(c.tx, c.deps, a, found, { dueOn: payload.toDueOn });
      return;
    }
    case "occurrence_skip": {
      const found = await occurrence(c, payload.occurrenceId, payload.ownerUserId, payload.dueOn);
      await applyOccurrencePatch(c.tx, c.deps, a, found, { status: "skipped" });
      return;
    }
    case "planned_delete": {
      await applyPlannedDelete(c.tx, a, await planned(c, payload.plannedExpenseId, payload.ownerUserId));
      return;
    }
    case "planned_patch": {
      const current = await planned(c, payload.plannedExpenseId, payload.ownerUserId);
      if (!unchanged(payload.before, current, PLANNED_GUARDED)) {
        throw new Superseded("The planned expense changed since it was proposed.");
      }
      await applyPlannedPatch(c.tx, a, current, payload.changes);
      return;
    }
  }
}
