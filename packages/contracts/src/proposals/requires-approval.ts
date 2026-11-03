// The product rule for which changes need the other member's approval (BACKEND_PLAN §7.3). Low-impact edits
// (renaming, reminders, your own items, Both and Split items) apply immediately with an activity entry;
// they have no entry here. The API asks this function and never decides on its own.

export type OwnerRef = {
  ownerType: "member" | "both" | "split";
  ownerUserId: string | null;
};

/** Changes that may need approval, as the API sees them after reading the current row. */
export type ApprovalChange =
  /** A goal's monthly deposit changes: it moves the shared plan. */
  | { type: "goal_monthly"; fromCents: number; toCents: number }
  /** Deleting a goal that still has a monthly deposit. */
  | { type: "goal_delete"; monthlyCents: number }
  /** Archiving or restoring a goal with a monthly deposit adds or removes that deposit from the plan. */
  | { type: "goal_status"; monthlyCents: number }
  /**
   * A new target that crosses the saved amount turns the goal "reached" or "not reached", and the engine
   * skips transfers to a reached goal: the monthly deposit leaves or joins the plan.
   */
  | { type: "goal_target"; crossesReached: boolean; monthlyCents: number }
  /** Taking money out of the emergency fund, or out of a goal that still has a monthly deposit. */
  | { type: "goal_withdrawal"; isEmergencyFund: boolean; monthlyCents: number }
  /** Deleting, re-owning, pausing or re-scheduling an item; moving or skipping one of its occurrences. */
  | ({
      type:
        | "item_delete"
        | "item_owner"
        | "item_status"
        | "item_schedule"
        | "occurrence_move"
        | "occurrence_skip"
        | "planned_delete"
        | "planned_owner"
        | "planned_move";
    } & OwnerRef);

/** True when `actorUserId` may not make this change alone. */
export function requiresApproval(change: ApprovalChange, actorUserId: string): boolean {
  if (change.type === "goal_monthly") return change.fromCents !== change.toCents;
  if (change.type === "goal_delete" || change.type === "goal_status") return change.monthlyCents > 0;
  if (change.type === "goal_target") return change.crossesReached && change.monthlyCents > 0;
  if (change.type === "goal_withdrawal") return change.isEmergencyFund || change.monthlyCents > 0;
  // Item-like changes: only the other member's own items. A member's own items and Both/Split items are
  // directly editable.
  return change.ownerType === "member" && change.ownerUserId !== null && change.ownerUserId !== actorUserId;
}

/** Proposals expire this many days after they are made (BACKEND_PLAN §7.3). */
export const PROPOSAL_TTL_DAYS = 7;
