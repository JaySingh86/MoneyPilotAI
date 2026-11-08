// Proposals: create goal and shortfall proposals, list them, approve or reject (BACKEND_PLAN §7.3,
// ARCHITECTURE §4.5). The proposer can never decide their own proposal (also a CHECK and an RLS policy). On
// approval the payload is re-validated against the current rows; if the data it was based on changed the
// proposal is marked `superseded` and nothing is applied. A pending proposal past its 7 days is `expired`.
import { sql } from "drizzle-orm";
import { AppError, ProposalPayload, type CreateProposal, type Proposal } from "@mp/contracts";
import { autoCompleteTasks, type Tx } from "@mp/db";
import { computePlan, shortfallOptions, whatIf } from "@mp/engine";
import { invalid, notFound } from "../items/changes";
import * as itemsRepo from "../items/repo";
import { mapDbError, type Actor, type ItemsDeps } from "../items/service";
import { engineSafe } from "../goals/service";
import { loadPlanInput } from "../goals/load-input";
import * as goalsRepo from "../goals/repo";
import { assertCanWrite, canWriteFeature } from "../billing/guard";
import { notifyProposalDecided } from "../notify/hooks";
import { applyPayload, Superseded } from "./apply";
import { insertProposal, PROPOSAL_COLUMNS, toProposal } from "./core";

export type ProposalsDeps = ItemsDeps;

/**
 * Payloads that change a goal or a goal's saved money. Goals are a Family Plus feature (WP-25), and a
 * proposal is just another way to write one, so it is checked when it is created and again when it is
 * approved (the plan can lapse in between).
 */
function changesGoals(type: string): boolean {
  return type.startsWith("goal_") || type === "shortfall_move_from_fund";
}

async function inTx<T>(deps: ProposalsDeps, a: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

// ===== Reads =====
export async function listProposals(
  deps: ProposalsDeps,
  a: Actor,
  filter: { status?: Proposal["status"] | undefined; limit: number },
) {
  return inTx(deps, a, async (tx) => {
    const now = deps.now();
    // A pending proposal past its expiry reads as expired before the hourly job records it.
    const status = filter.status
      ? filter.status === "pending"
        ? sql`and status = 'pending' and expires_at > ${now}::timestamptz`
        : filter.status === "expired"
          ? sql`and (status = 'expired' or (status = 'pending' and expires_at <= ${now}::timestamptz))`
          : sql`and status = ${filter.status}`
      : sql``;
    const res = await tx.execute(sql`select ${PROPOSAL_COLUMNS} from proposals
      where household_id = ${a.householdId} ${status} order by created_at desc, id limit ${filter.limit}`);
    return { data: res.rows.map((r) => toProposal(r, now)) };
  });
}

export async function getProposal(deps: ProposalsDeps, a: Actor, id: string): Promise<Proposal> {
  return inTx(deps, a, async (tx) => {
    const res = await tx.execute(
      sql`select ${PROPOSAL_COLUMNS} from proposals where id = ${id} and household_id = ${a.householdId}`,
    );
    const row = res.rows[0];
    if (!row) throw notFound("Proposal");
    return toProposal(row, deps.now());
  });
}

// ===== Create =====
async function requireApprover(tx: Tx, a: Actor): Promise<void> {
  const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from household_members
    where household_id = ${a.householdId} and left_at is null and user_id <> ${a.userId}`);
  if (Number(res.rows[0]?.n ?? 0) === 0) {
    throw new AppError("conflict", 409, "There is no one else in the household to approve this change.");
  }
}

export async function createProposal(deps: ProposalsDeps, a: Actor, body: CreateProposal): Promise<Proposal> {
  return inTx(deps, a, async (tx) => {
    if (body.type === "goal_monthly") await assertCanWrite(tx, a.householdId, "goals");
    await requireApprover(tx, a);
    const input = await loadPlanInput(tx, a.householdId, deps.now(), { requireBalance: true });
    let payload: ProposalPayload;
    if (body.type === "goal_monthly") {
      const goal = await goalsRepo.getGoal(tx, a.householdId, body.goalId);
      if (!goal) throw notFound("Goal");
      if (goal.monthlyCents === body.monthlyCents) {
        throw invalid("monthlyCents", "That is already the monthly amount.");
      }
      const diff = engineSafe(
        () =>
          whatIf(input, [{ type: "set_goal_monthly", goalId: goal.id, monthlyCents: body.monthlyCents }])
            .diff,
      );
      payload = {
        type: "goal_monthly",
        goalId: goal.id,
        goalName: goal.name,
        fromMonthlyCents: goal.monthlyCents,
        toMonthlyCents: body.monthlyCents,
        effect: {
          safeToSpendBeforeCents: diff.safeToSpendBeforeCents,
          safeToSpendAfterCents: diff.safeToSpendAfterCents,
        },
      };
    } else {
      const base = engineSafe(() => computePlan(input));
      const option = engineSafe(() => shortfallOptions(input, base)).find((o) => o.kind === body.option);
      if (!option) {
        throw new AppError("conflict", 409, "That option is not available for the current plan.");
      }
      const effect = {
        safeToSpendBeforeCents: base.safeToSpendCents,
        safeToSpendAfterCents: option.result.safeToSpendCents,
      };
      if (option.kind === "move_from_emergency_fund") {
        const goal = await goalsRepo.getGoal(tx, a.householdId, option.goalId);
        if (!goal) throw notFound("Goal");
        payload = {
          type: "shortfall_move_from_fund",
          goalId: goal.id,
          goalName: goal.name,
          amountCents: option.amountCents,
          fundBalanceCents: goal.savedCents,
          effect,
        };
      } else if (option.kind === "split_expense") {
        const expense = await itemsRepo.getPlanned(tx, a.householdId, option.plannedExpenseId);
        if (!expense) throw notFound("Planned expense");
        payload = {
          type: "shortfall_split_expense",
          plannedExpenseId: expense.id,
          name: expense.name,
          amountCents: expense.amountCents,
          amountNowCents: option.amountNowCents,
          nowOn: option.nowOn,
          laterOn: option.afterPaydayOn,
          effect,
        };
      } else {
        const bill = await itemsRepo.getItem(tx, a.householdId, option.itemId);
        if (!bill) throw notFound("Item");
        payload = {
          type: "shortfall_move_bill",
          itemId: bill.id,
          itemName: bill.name,
          scheduledOn: option.scheduledOn,
          fromDate: option.fromDate,
          toDate: option.toDate,
          amountCents: option.amountCents,
          effect,
        };
      }
    }
    if (changesGoals(payload.type)) await assertCanWrite(tx, a.householdId, "goals");
    return insertProposal(tx, {
      householdId: a.householdId,
      proposedBy: a.userId,
      payload,
      nowIso: deps.now(),
    });
  });
}

// ===== Decide =====
type Outcome = { kind: "decided"; proposal: Proposal } | { kind: "stale"; message: string };

async function lockPending(
  tx: Tx,
  deps: ProposalsDeps,
  a: Actor,
  id: string,
): Promise<{ proposal: Proposal } | { stale: string }> {
  // Read first: the row lock below only sees pending rows (the update policy), so a decided proposal would
  // otherwise look missing.
  const res = await tx.execute(sql`select ${PROPOSAL_COLUMNS}, status as raw_status from proposals
    where id = ${id} and household_id = ${a.householdId}`);
  const row = res.rows[0];
  if (!row) throw notFound("Proposal");
  const proposal = toProposal(row, deps.now());
  // The approver must differ from the proposer (BACKEND_PLAN §8.2).
  if (proposal.proposedBy === a.userId) {
    throw new AppError("forbidden", 403, "Your partner has to decide on a change you proposed.");
  }
  if (row.raw_status !== "pending") {
    return { stale: `This proposal was already ${String(row.raw_status)}.` };
  }
  // Lock it, so two answers at once can't both apply it.
  const locked = await tx.execute(
    sql`select 1 from proposals where id = ${id} and status = 'pending' for update`,
  );
  if (locked.rows.length === 0) return { stale: "This proposal was just decided." };
  if (proposal.status === "expired") {
    await closeProposal(tx, id, "expired", "Not decided within 7 days.");
    return { stale: "This proposal expired. Ask again." };
  }
  return { proposal };
}

async function closeProposal(tx: Tx, id: string, status: "expired" | "superseded", note: string) {
  await tx.execute(sql`update proposals set status = ${status}, decision_note = ${note} where id = ${id}`);
}

async function audit(tx: Tx, a: Actor, action: string, id: string, type: string) {
  await tx.execute(sql`insert into audit_events
      (household_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata)
    values (${a.householdId}, ${a.userId}, 'user', ${action}, 'proposal', ${id},
      ${JSON.stringify({ type })}::jsonb)`);
}

/** A failure caused by the data (a rule, a missing row), not a fault of ours. */
function isApplyFailure(err: unknown): boolean {
  if (err instanceof AppError) return [400, 404, 409].includes(err.status);
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^23\d{3}$/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function reload(tx: Tx, deps: ProposalsDeps, a: Actor, id: string): Promise<Proposal> {
  const res = await tx.execute(
    sql`select ${PROPOSAL_COLUMNS} from proposals where id = ${id} and household_id = ${a.householdId}`,
  );
  const row = res.rows[0];
  if (!row) throw notFound("Proposal");
  return toProposal(row, deps.now());
}

function settle(outcome: Outcome): Proposal {
  if (outcome.kind === "stale") throw new AppError("conflict", 409, outcome.message);
  return outcome.proposal;
}

export async function approveProposal(deps: ProposalsDeps, a: Actor, id: string): Promise<Proposal> {
  // A stale or expired proposal is recorded as such and answered 409 after the transaction commits.
  const outcome = await inTx<Outcome>(deps, a, async (tx) => {
    const locked = await lockPending(tx, deps, a, id);
    if ("stale" in locked) return { kind: "stale", message: locked.stale };
    const { proposal } = locked;
    // The stored payload is data like any other: parse it again before acting on it (L1).
    const parsed = ProposalPayload.safeParse(proposal.payload);
    if (!parsed.success) {
      await closeProposal(tx, id, "superseded", "The request could not be read.");
      await audit(tx, a, "proposal.superseded", id, "invalid");
      await notifyProposalDecided(tx, a, proposal, "superseded");
      return { kind: "stale", message: "This proposal is no longer valid. Ask again." };
    }
    // The plan can lapse between create and approve. A blocked approval ends the proposal like any other one
    // that can no longer be applied, instead of leaving it pending for a plan that may never come back.
    if (changesGoals(parsed.data.type) && !(await canWriteFeature(tx, a.householdId, "goals"))) {
      await closeProposal(tx, id, "superseded", "Goals need Family Plus.");
      await audit(tx, a, "proposal.superseded", id, parsed.data.type);
      return { kind: "stale", message: "This change needs Family Plus, so it was not applied." };
    }
    try {
      // A savepoint: a failed apply (a database error aborts the transaction) leaves nothing half applied
      // and lets us record the outcome on the proposal.
      await tx.transaction(async (savepoint) =>
        applyPayload(
          {
            tx: savepoint as unknown as Tx,
            deps,
            householdId: a.householdId,
            proposerId: proposal.proposedBy,
            approverId: a.userId,
          },
          parsed.data,
        ),
      );
    } catch (err) {
      // Not applicable any more: the data changed (Superseded), or the change now breaks a rule (the primary
      // income, an owner who left). Either way the proposal ends instead of staying pending forever (L4).
      const note =
        err instanceof Superseded ? err.note : isApplyFailure(err) ? "It could not be applied." : null;
      if (note === null) throw err;
      await closeProposal(tx, id, "superseded", note);
      await audit(tx, a, "proposal.superseded", id, proposal.payload.type);
      await notifyProposalDecided(tx, a, proposal, "superseded");
      return { kind: "stale", message: "This proposal is out of date because the data changed. Ask again." };
    }
    await tx.execute(sql`update proposals
      set status = 'applied', decided_by = ${a.userId}, decided_at = ${deps.now()}::timestamptz where id = ${id}`);
    await audit(tx, a, "proposal.approved", id, proposal.payload.type);
    await notifyProposalDecided(tx, a, proposal, "approved");
    await autoCompleteTasks(tx, a.householdId, { type: "proposal_decided", proposalId: id }, a.userId);
    return { kind: "decided", proposal: await reload(tx, deps, a, id) };
  });
  return settle(outcome);
}

export async function rejectProposal(
  deps: ProposalsDeps,
  a: Actor,
  id: string,
  note?: string,
): Promise<Proposal> {
  const outcome = await inTx<Outcome>(deps, a, async (tx) => {
    const locked = await lockPending(tx, deps, a, id);
    if ("stale" in locked) return { kind: "stale", message: locked.stale };
    await tx.execute(sql`update proposals
      set status = 'rejected', decided_by = ${a.userId}, decided_at = ${deps.now()}::timestamptz,
          decision_note = ${note ?? null}
      where id = ${id}`);
    await audit(tx, a, "proposal.rejected", id, locked.proposal.payload.type);
    await notifyProposalDecided(tx, a, locked.proposal, "rejected");
    await autoCompleteTasks(tx, a.householdId, { type: "proposal_decided", proposalId: id }, a.userId);
    return { kind: "decided", proposal: await reload(tx, deps, a, id) };
  });
  return settle(outcome);
}
