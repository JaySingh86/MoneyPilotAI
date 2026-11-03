// Business rules for goals, deposits and the ways to close a gap. Every number shown (status, percent,
// suggestions, options, the effect on safe to spend) comes from `@mp/engine`; this layer reads rows, asks
// the engine, and maps the answer (hard rule 4). A change to a goal's monthly amount moves the shared plan,
// so it becomes a proposal the other member approves (BACKEND_PLAN §7.3).
import { sql } from "drizzle-orm";
import {
  AppError,
  requiresApproval,
  type CreateGoal,
  type CreateGoalEvent,
  type GoalEvent,
  type Proposal,
  type Goal,
  type GoalOption,
  type GoalOptions,
  type GoalProgress,
  type PatchGoal,
} from "@mp/contracts";
import type { Tx } from "@mp/db";
import {
  EngineError,
  goalDepositDates,
  goalStatus,
  computePlan,
  goalsSummary,
  whatIf,
  type EngineInput,
  type GoalInput,
  type GoalStatus,
} from "@mp/engine";
import { assertVersion } from "../../lib/if-match";
import { mapDbError, type Actor, type ItemsDeps } from "../items/service";
import { invalid, notFound, todayFor } from "../items/changes";
import { insertProposal, type Gated } from "../proposals/core";
import { applyGoalDelete, eventDelta, recordGoalEvent, statusFor } from "./changes";
import { loadPlanInput } from "./load-input";
import * as repo from "./repo";

export type GoalsDeps = ItemsDeps;

async function inTx<T>(deps: GoalsDeps, a: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

/** Engine failures are a state of the household's data, not a server fault; details carry no amounts. */
export function engineSafe<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof EngineError) {
      throw new AppError("conflict", 409, "The plan can't be calculated from the current data yet.");
    }
    throw err;
  }
}

export function inputFromRow(g: repo.GoalRow): GoalInput {
  return {
    id: g.id,
    name: g.name,
    type: g.type,
    targetCents: g.targetCents,
    savedCents: g.savedCents,
    monthlyCents: g.monthlyCents,
    targetDate: g.targetDate,
    emergencyFund: g.isEmergencyFund,
  };
}

function toProgress(s: GoalStatus): GoalProgress {
  return {
    status: s.status,
    percent: s.percent,
    remainingCents: s.remainingCents,
    reachMonth: s.reachMonth,
    contributionsByTarget: s.contributionsByTarget,
    projectedByTargetCents: s.projectedByTargetCents,
    gapCents: s.gapCents,
    suggestedMonthlyCents: s.suggestedMonthlyCents,
    alternativeTargetDate: s.alternativeTargetDate,
  };
}

function toGoal(row: repo.GoalRow, status: GoalStatus): Goal {
  return { ...row, progress: toProgress(status) };
}

async function engineInput(tx: Tx, deps: GoalsDeps, a: Actor, requireBalance = false): Promise<EngineInput> {
  return loadPlanInput(tx, a.householdId, deps.now(), { requireBalance });
}

async function otherMembers(tx: Tx, a: Actor): Promise<number> {
  const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from household_members
    where household_id = ${a.householdId} and left_at is null and user_id <> ${a.userId}`);
  return Number(res.rows[0]?.n ?? 0);
}

async function goalView(tx: Tx, deps: GoalsDeps, a: Actor, id: string): Promise<Goal> {
  const row = await repo.getGoal(tx, a.householdId, id);
  if (!row) throw notFound("Goal");
  const input = await engineInput(tx, deps, a);
  return toGoal(
    row,
    engineSafe(() => goalStatus(input, inputFromRow(row))),
  );
}

// ===== Reads =====
/** The Goals screen. Archived goals are not listed (`getGoal` still reads one). */
export async function listGoals(deps: GoalsDeps, a: Actor) {
  return inTx(deps, a, async (tx) => {
    const input = await engineInput(tx, deps, a);
    const summary = engineSafe(() => goalsSummary(input));
    const rows = await repo.listGoals(tx, a.householdId);
    const status = new Map(summary.goals.map((g) => [g.goalId, g]));
    const next = engineSafe(() => goalDepositDates(input).next());
    return {
      savingEachMonthCents: summary.savingEachMonthCents,
      savedSoFarCents: summary.savedSoFarCents,
      effectOnSafeToSpendCents: summary.effectOnSafeToSpendCents,
      nextTransferOn: next.done ? null : next.value.toString(),
      data: rows.flatMap((row) => {
        const s = status.get(row.id);
        return s ? [toGoal(row, s)] : [];
      }),
    };
  });
}

export async function getGoal(deps: GoalsDeps, a: Actor, id: string): Promise<Goal> {
  return inTx(deps, a, (tx) => goalView(tx, deps, a, id));
}

export async function goalOptions(deps: GoalsDeps, a: Actor, id: string): Promise<GoalOptions> {
  return inTx(deps, a, async (tx) => {
    const row = await repo.getGoal(tx, a.householdId, id);
    if (!row) throw notFound("Goal");
    const input = await engineInput(tx, deps, a);
    const s = engineSafe(() => goalStatus(input, inputFromRow(row)));
    const options: GoalOption[] = [];
    if (s.status === "behind" || s.status === "to_set_aside") {
      if (s.suggestedMonthlyCents !== null) {
        options.push({ kind: "raise_monthly", monthlyCents: s.suggestedMonthlyCents });
      }
      if (s.alternativeTargetDate !== null) {
        options.push({ kind: "move_date", targetDate: s.alternativeTargetDate });
      }
      if (s.projectedByTargetCents !== null && s.projectedByTargetCents >= 1) {
        options.push({ kind: "lower_target", targetCents: s.projectedByTargetCents });
      }
    }
    return { goalId: id, status: s.status, options };
  });
}

// ===== Writes =====
export type CreatedGoal = { goal: Goal } | { goal: Goal; proposal: Proposal };

/**
 * A goal with a monthly amount, when someone else can approve, is created with monthly 0 plus a pending
 * `goal_monthly` proposal for the requested amount (the monthly amount is what moves the shared plan).
 * Target and date edits stay direct: the engine derives deposits from the monthly amount only.
 */
export async function createGoal(deps: GoalsDeps, a: Actor, body: CreateGoal): Promise<CreatedGoal> {
  return inTx(deps, a, async (tx) => {
    const gated = body.monthlyCents > 0 && (await otherMembers(tx, a)) > 0;
    const id = await repo.insertGoal(tx, a.householdId, a.userId, {
      name: body.name,
      type: body.type,
      targetCents: body.targetCents,
      savedCents: body.savedCents,
      monthlyCents: gated ? 0 : body.monthlyCents,
      targetDate: body.targetDate ?? null,
      colorSlot: body.colorSlot,
      isEmergencyFund: body.isEmergencyFund,
      status: statusFor(body.savedCents, body.targetCents, "active"),
    });
    await repo.audit(tx, a.householdId, a.userId, "goal.created", "goal", id);
    if (!gated) return { goal: await goalView(tx, deps, a, id) };
    const input = await engineInput(tx, deps, a, true);
    const diff = engineSafe(
      () => whatIf(input, [{ type: "set_goal_monthly", goalId: id, monthlyCents: body.monthlyCents }]).diff,
    );
    const proposal = await insertProposal(tx, {
      householdId: a.householdId,
      proposedBy: a.userId,
      nowIso: deps.now(),
      payload: {
        type: "goal_monthly",
        goalId: id,
        goalName: body.name,
        fromMonthlyCents: 0,
        toMonthlyCents: body.monthlyCents,
        effect: {
          safeToSpendBeforeCents: diff.safeToSpendBeforeCents,
          safeToSpendAfterCents: diff.safeToSpendAfterCents,
        },
      },
    });
    return { goal: await goalView(tx, deps, a, id), proposal };
  });
}

export async function patchGoal(
  deps: GoalsDeps,
  a: Actor,
  id: string,
  expected: number,
  body: PatchGoal,
): Promise<Gated<Goal>> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getGoal(tx, a.householdId, id, true);
    if (!current) throw notFound("Goal");
    assertVersion(expected, current);

    const monthlyChanged = body.monthlyCents !== undefined && body.monthlyCents !== current.monthlyCents;
    // Someone has to approve: a household with one adult edits its goals directly.
    if (
      monthlyChanged &&
      body.monthlyCents !== undefined &&
      requiresApproval(
        { type: "goal_monthly", fromCents: current.monthlyCents, toCents: body.monthlyCents },
        a.userId,
      ) &&
      (await otherMembers(tx, a)) > 0
    ) {
      const extra = Object.keys(body).filter((k) => k !== "monthlyCents");
      if (extra.length > 0) {
        throw invalid(extra[0] ?? "", "A monthly amount change needs approval and must be sent on its own.");
      }
      const input = await engineInput(tx, deps, a, true);
      const diff = engineSafe(
        () =>
          whatIf(input, [{ type: "set_goal_monthly", goalId: id, monthlyCents: body.monthlyCents ?? 0 }])
            .diff,
      );
      return {
        proposal: await insertProposal(tx, {
          householdId: a.householdId,
          proposedBy: a.userId,
          nowIso: deps.now(),
          payload: {
            type: "goal_monthly",
            goalId: id,
            goalName: current.name,
            fromMonthlyCents: current.monthlyCents,
            toMonthlyCents: body.monthlyCents,
            effect: {
              safeToSpendBeforeCents: diff.safeToSpendBeforeCents,
              safeToSpendAfterCents: diff.safeToSpendAfterCents,
            },
          },
        }),
      };
    }

    // Archiving or restoring a goal that has a monthly amount adds or removes that deposit from the plan, so it
    // is a monthly-amount change in disguise. The engine's goal list leaves archived goals out.
    const archiving =
      body.status !== undefined && (body.status === "archived") !== (current.status === "archived");
    if (
      archiving &&
      body.status !== undefined &&
      requiresApproval({ type: "goal_status", monthlyCents: current.monthlyCents }, a.userId) &&
      (await otherMembers(tx, a)) > 0
    ) {
      const extra = Object.keys(body).filter((k) => k !== "status");
      if (extra.length > 0) {
        throw invalid(
          extra[0] ?? "",
          "Archiving or restoring a goal needs approval and must be sent on its own.",
        );
      }
      const input = await engineInput(tx, deps, a, true);
      const withGoal: EngineInput = input.goals.some((g) => g.id === id)
        ? input
        : { ...input, goals: [...input.goals, inputFromRow(current)] };
      const withoutGoal: EngineInput = { ...input, goals: input.goals.filter((g) => g.id !== id) };
      const [before, after] = body.status === "archived" ? [withGoal, withoutGoal] : [withoutGoal, withGoal];
      const effect = engineSafe(() => ({
        safeToSpendBeforeCents: computePlan(before).safeToSpendCents,
        safeToSpendAfterCents: computePlan(after).safeToSpendCents,
      }));
      return {
        proposal: await insertProposal(tx, {
          householdId: a.householdId,
          proposedBy: a.userId,
          nowIso: deps.now(),
          payload: {
            type: "goal_status",
            goalId: id,
            goalName: current.name,
            fromStatus: current.status,
            toStatus: body.status,
            monthlyCents: current.monthlyCents,
            effect,
          },
        }),
      };
    }

    // The engine skips transfers to a reached goal (saved >= target), so a target that crosses the saved
    // amount adds or removes the monthly deposit: the same plan change as a new monthly amount.
    const crossesReached =
      body.targetCents !== undefined &&
      current.savedCents >= current.targetCents !== current.savedCents >= body.targetCents;
    if (
      crossesReached &&
      body.targetCents !== undefined &&
      current.status !== "archived" &&
      requiresApproval(
        { type: "goal_target", crossesReached, monthlyCents: current.monthlyCents },
        a.userId,
      ) &&
      (await otherMembers(tx, a)) > 0
    ) {
      const extra = Object.keys(body).filter((k) => k !== "targetCents");
      if (extra.length > 0) {
        throw invalid(
          extra[0] ?? "",
          "A target that changes the plan needs approval and must be sent on its own.",
        );
      }
      const input = await engineInput(tx, deps, a, true);
      const toTarget = body.targetCents;
      const after: EngineInput = {
        ...input,
        goals: input.goals.map((g) => (g.id === id ? { ...g, targetCents: toTarget } : g)),
      };
      const effect = engineSafe(() => ({
        safeToSpendBeforeCents: computePlan(input).safeToSpendCents,
        safeToSpendAfterCents: computePlan(after).safeToSpendCents,
      }));
      return {
        proposal: await insertProposal(tx, {
          householdId: a.householdId,
          proposedBy: a.userId,
          nowIso: deps.now(),
          payload: {
            type: "goal_target",
            goalId: id,
            goalName: current.name,
            fromTargetCents: current.targetCents,
            toTargetCents: toTarget,
            monthlyCents: current.monthlyCents,
            effect,
          },
        }),
      };
    }

    const columns: Record<string, unknown> = {};
    if (body.name !== undefined) columns.name = body.name;
    if (body.targetCents !== undefined) columns.target_cents = body.targetCents;
    if (body.targetDate !== undefined) columns.target_date = body.targetDate;
    if (body.colorSlot !== undefined) columns.color_slot = body.colorSlot;
    if (body.monthlyCents !== undefined) columns.monthly_cents = body.monthlyCents;
    if (body.status !== undefined || body.targetCents !== undefined) {
      const base = body.status ?? (current.status === "archived" ? "archived" : "active");
      columns.status = statusFor(current.savedCents, body.targetCents ?? current.targetCents, base);
    }
    if (!(await repo.updateGoal(tx, id, expected, columns))) {
      throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
    }
    await repo.audit(tx, a.householdId, a.userId, "goal.updated", "goal", id);
    return { applied: await goalView(tx, deps, a, id) };
  });
}

export async function deleteGoal(deps: GoalsDeps, a: Actor, id: string): Promise<Gated<null>> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getGoal(tx, a.householdId, id, true);
    if (!current) throw notFound("Goal");
    if (
      requiresApproval({ type: "goal_delete", monthlyCents: current.monthlyCents }, a.userId) &&
      (await otherMembers(tx, a)) > 0
    ) {
      return {
        proposal: await insertProposal(tx, {
          householdId: a.householdId,
          proposedBy: a.userId,
          nowIso: deps.now(),
          payload: { type: "goal_delete", goalId: id, goalName: current.name },
        }),
      };
    }
    await applyGoalDelete(tx, a, current);
    return { applied: null };
  });
}

export type RecordedEvent = { event: GoalEvent; goal: Goal } | { proposal: Proposal };

/**
 * Deposits are direct. Taking money out of the emergency fund, or out of a goal that still has a monthly
 * amount, needs the other member's approval (when someone else can approve).
 */
export async function createGoalEvent(
  deps: GoalsDeps,
  a: Actor,
  id: string,
  body: CreateGoalEvent,
): Promise<RecordedEvent> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getGoal(tx, a.householdId, id, true);
    if (!current) throw notFound("Goal");
    const occurredOn = body.occurredOn ?? (await todayFor(tx, deps, a.householdId));
    const takesOut = body.kind === "withdrawal" || (body.kind === "adjustment" && body.amountCents < 0);
    if (
      takesOut &&
      requiresApproval(
        {
          type: "goal_withdrawal",
          isEmergencyFund: current.isEmergencyFund,
          monthlyCents: current.monthlyCents,
        },
        a.userId,
      ) &&
      (await otherMembers(tx, a)) > 0
    ) {
      if (current.savedCents + eventDelta(body.kind, body.amountCents) < 0) {
        throw invalid("amountCents", "A goal can't hold less than $0");
      }
      return {
        proposal: await insertProposal(tx, {
          householdId: a.householdId,
          proposedBy: a.userId,
          nowIso: deps.now(),
          payload: {
            type: "goal_withdrawal",
            goalId: id,
            goalName: current.name,
            kind: body.kind === "adjustment" ? "adjustment" : "withdrawal",
            amountCents: body.amountCents,
            occurredOn,
            note: body.note ?? null,
          },
        }),
      };
    }
    const event = await recordGoalEvent(tx, a, current, {
      kind: body.kind,
      amountCents: body.amountCents,
      occurredOn,
      note: body.note ?? null,
    });
    return { event, goal: await goalView(tx, deps, a, id) };
  });
}
