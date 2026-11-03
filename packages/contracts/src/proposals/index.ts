// Proposals: "Ask Jordan to approve" (WP-13; BACKEND_PLAN §7.3, §8.2; ARCHITECTURE §4.5). A change that
// affects the shared plan becomes a proposal the other member approves or rejects. Payload amounts and
// dates come from the engine or from the current rows; the client never supplies a number the plan uses.
import { z } from "zod";
import { Cents, IsoDate, Timestamp, Uuid } from "../common";
import { PatchItem, PatchPlannedExpense } from "../items";

export * from "./requires-approval";

const Money = Cents.min(0);

/** The engine's what-if result for the change, stored with the proposal so "See the math" matches. */
export const ProposalEffect = z
  .object({
    safeToSpendBeforeCents: Cents,
    safeToSpendAfterCents: Cents,
  })
  .meta({ id: "ProposalEffect" });

/** Old and new values of the fields a change touches; compared again when the proposal is approved. */
const Snapshot = z.record(z.string(), z.unknown());

export const ProposalPayload = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("goal_monthly"),
      goalId: Uuid,
      goalName: z.string(),
      fromMonthlyCents: Money,
      toMonthlyCents: Money,
      effect: ProposalEffect,
    }),
    z.object({ type: z.literal("goal_delete"), goalId: Uuid, goalName: z.string() }),
    z.object({
      type: z.literal("goal_status"),
      goalId: Uuid,
      goalName: z.string(),
      fromStatus: z.enum(["active", "reached", "archived"]),
      toStatus: z.enum(["active", "archived"]),
      /** The deposit that leaves or joins the plan. */
      monthlyCents: Money,
      effect: ProposalEffect,
    }),
    z.object({
      type: z.literal("goal_target"),
      goalId: Uuid,
      goalName: z.string(),
      fromTargetCents: Money,
      toTargetCents: Money,
      monthlyCents: Money,
      effect: ProposalEffect,
    }),
    z.object({
      type: z.literal("goal_withdrawal"),
      goalId: Uuid,
      goalName: z.string(),
      kind: z.enum(["withdrawal", "adjustment"]),
      /** Positive for a withdrawal; negative for an adjustment. */
      amountCents: Cents,
      occurredOn: IsoDate,
      note: z.string().nullable(),
    }),
    z.object({
      type: z.literal("shortfall_move_from_fund"),
      goalId: Uuid,
      goalName: z.string(),
      amountCents: Money,
      fundBalanceCents: Money,
      effect: ProposalEffect,
    }),
    z.object({
      type: z.literal("shortfall_split_expense"),
      plannedExpenseId: Uuid,
      name: z.string(),
      amountCents: Money,
      amountNowCents: Money,
      nowOn: IsoDate,
      laterOn: IsoDate,
      effect: ProposalEffect,
    }),
    z.object({
      type: z.literal("shortfall_move_bill"),
      itemId: Uuid,
      itemName: z.string(),
      scheduledOn: IsoDate,
      fromDate: IsoDate,
      toDate: IsoDate,
      amountCents: Money,
      effect: ProposalEffect,
    }),
    z.object({
      type: z.literal("item_delete"),
      itemId: Uuid,
      itemName: z.string(),
      ownerUserId: Uuid.nullable(),
    }),
    z.object({
      type: z.literal("item_patch"),
      itemId: Uuid,
      itemName: z.string(),
      ownerUserId: Uuid.nullable(),
      changes: PatchItem,
      before: Snapshot,
    }),
    z.object({
      type: z.literal("occurrence_move"),
      occurrenceId: Uuid,
      itemId: Uuid,
      itemName: z.string(),
      ownerUserId: Uuid.nullable(),
      fromDueOn: IsoDate,
      toDueOn: IsoDate,
    }),
    z.object({
      type: z.literal("occurrence_skip"),
      occurrenceId: Uuid,
      itemId: Uuid,
      itemName: z.string(),
      ownerUserId: Uuid.nullable(),
      dueOn: IsoDate,
    }),
    z.object({
      type: z.literal("planned_delete"),
      plannedExpenseId: Uuid,
      name: z.string(),
      ownerUserId: Uuid.nullable(),
    }),
    z.object({
      type: z.literal("planned_patch"),
      plannedExpenseId: Uuid,
      name: z.string(),
      ownerUserId: Uuid.nullable(),
      changes: PatchPlannedExpense,
      before: Snapshot,
    }),
  ])
  .meta({ id: "ProposalPayload" });
export type ProposalPayload = z.infer<typeof ProposalPayload>;

export const PROPOSAL_KINDS = ["goal_change", "item_change", "shortfall_option", "plan_option"] as const;
export const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "applied",
  "superseded",
] as const;

/** The proposal kind a payload belongs to (the `kind` column). */
export function proposalKind(payload: ProposalPayload): (typeof PROPOSAL_KINDS)[number] {
  if (payload.type.startsWith("goal_")) return "goal_change";
  if (payload.type.startsWith("shortfall_")) return "shortfall_option";
  return "item_change";
}

export const Proposal = z
  .object({
    id: Uuid,
    householdId: Uuid,
    kind: z.enum(PROPOSAL_KINDS),
    payload: ProposalPayload,
    calcSnapshotId: Uuid.nullable(),
    proposedBy: Uuid,
    /** A pending proposal past its expiry reads as `expired` before the hourly job records it. */
    status: z.enum(PROPOSAL_STATUSES),
    decidedBy: Uuid.nullable(),
    decidedAt: Timestamp.nullable(),
    /** Why it was superseded or expired; null otherwise. */
    decisionNote: z.string().nullable(),
    expiresAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: "Proposal" });
export type Proposal = z.infer<typeof Proposal>;

export const ProposalList = z.object({ data: z.array(Proposal) }).meta({ id: "ProposalList" });

/** Every payload type names one target (occurrence, planned expense, goal or item) for the one-pending rule. */
export function proposalTarget(payload: ProposalPayload): string | null {
  const p = payload as Record<string, unknown>;
  for (const key of ["occurrenceId", "plannedExpenseId", "goalId", "itemId"]) {
    if (typeof p[key] === "string") return p[key];
  }
  return null;
}

/** Open proposals allowed per household. */
export const MAX_PENDING_PROPOSALS = 20;

export const ProposalListQuery = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ProposalParams = z.object({ hid: Uuid, id: Uuid });

export const SHORTFALL_OPTION_KINDS = [
  "move_from_emergency_fund",
  "split_expense",
  "move_bill_to_payday",
] as const;

/**
 * `POST …/proposals`. Goal and shortfall proposals are made here; the engine fills in every number. Item
 * changes become proposals through the items routes (202).
 */
export const CreateProposal = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("goal_monthly"), goalId: Uuid, monthlyCents: Money }),
    z.object({ type: z.literal("shortfall_option"), option: z.enum(SHORTFALL_OPTION_KINDS) }),
  ])
  .meta({ id: "CreateProposal" });
export type CreateProposal = z.infer<typeof CreateProposal>;

export const RejectProposalBody = z
  .object({ note: z.string().min(1).max(200).optional() })
  .meta({ id: "RejectProposalBody" });
