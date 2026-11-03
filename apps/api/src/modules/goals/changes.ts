// Transaction-level goal changes (WP-13). The service decides whether a change needs the other member's
// approval; these functions apply it inside a caller's transaction, so a direct edit and an approved
// proposal leave the same rows.
import { AppError, type CreateGoalEvent, type GoalEvent } from "@mp/contracts";
import type { Tx } from "@mp/db";
import * as repo from "./repo";

export interface GoalActor {
  householdId: string;
  /** The member credited with the change (the proposer, when a proposal is applied). */
  userId: string;
  /** The signed-in member, for rows RLS requires to name them (events, audit): the approver. */
  auditUserId?: string;
}

const sessionUser = (a: GoalActor): string => a.auditUserId ?? a.userId;

/** `reached` follows the saved amount; an archived goal stays archived. */
export function statusFor(
  savedCents: number,
  targetCents: number,
  current: repo.GoalRow["status"],
): repo.GoalRow["status"] {
  if (current === "archived") return "archived";
  return savedCents >= targetCents ? "reached" : "active";
}

/** The change in a goal's saved amount that an event stands for. */
export function eventDelta(kind: CreateGoalEvent["kind"], amountCents: number): number {
  return kind === "withdrawal" ? -amountCents : amountCents;
}

/**
 * Records a deposit, withdrawal or adjustment (MoneyPilot only reminds: the household moved the money
 * itself) and keeps `saved_cents` and the reached status in step, in the caller's transaction.
 */
export async function recordGoalEvent(
  tx: Tx,
  a: GoalActor,
  goal: repo.GoalRow,
  input: { kind: CreateGoalEvent["kind"]; amountCents: number; occurredOn: string; note: string | null },
): Promise<GoalEvent> {
  const saved = goal.savedCents + eventDelta(input.kind, input.amountCents);
  if (saved < 0) {
    throw new AppError("validation_failed", 400, "The request has invalid fields.", {
      fields: [{ in: "body", path: "amountCents", message: "A goal can't hold less than $0" }],
    });
  }
  const event = await repo.insertEvent(tx, a.householdId, sessionUser(a), goal.id, input);
  const ok = await repo.updateGoal(tx, goal.id, goal.version, {
    saved_cents: saved,
    status: statusFor(saved, goal.targetCents, goal.status),
  });
  if (!ok)
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
  await repo.audit(tx, a.householdId, sessionUser(a), "goal.event_recorded", "goal", goal.id);
  return event;
}

/** Sets the monthly deposit of a locked goal. */
export async function applyGoalMonthly(
  tx: Tx,
  a: GoalActor,
  goal: repo.GoalRow,
  monthlyCents: number,
): Promise<void> {
  if (!(await repo.updateGoal(tx, goal.id, goal.version, { monthly_cents: monthlyCents }))) {
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
  }
  await repo.audit(tx, a.householdId, sessionUser(a), "goal.monthly_changed", "goal", goal.id);
}

/** Archives or restores a locked goal (`reached` follows the saved amount). */
export async function applyGoalStatus(
  tx: Tx,
  a: GoalActor,
  goal: repo.GoalRow,
  toStatus: "active" | "archived",
): Promise<void> {
  const status = statusFor(goal.savedCents, goal.targetCents, toStatus);
  if (!(await repo.updateGoal(tx, goal.id, goal.version, { status }))) {
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
  }
  await repo.audit(tx, a.householdId, sessionUser(a), "goal.status_changed", "goal", goal.id);
}

/** Sets the target of a locked goal; `reached` follows the saved amount. */
export async function applyGoalTarget(
  tx: Tx,
  a: GoalActor,
  goal: repo.GoalRow,
  targetCents: number,
): Promise<void> {
  const status = statusFor(goal.savedCents, targetCents, goal.status);
  if (!(await repo.updateGoal(tx, goal.id, goal.version, { target_cents: targetCents, status }))) {
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
  }
  await repo.audit(tx, a.householdId, sessionUser(a), "goal.target_changed", "goal", goal.id);
}

export async function applyGoalDelete(tx: Tx, a: GoalActor, goal: repo.GoalRow): Promise<void> {
  await repo.softDeleteGoal(tx, goal.id);
  await repo.audit(tx, a.householdId, sessionUser(a), "goal.deleted", "goal", goal.id);
}
