import { describe, expect, it } from "vitest";
import { CreateGoal, CreateGoalEvent, PatchGoal } from "../goals";
import { CreateTask, PatchTask } from "../tasks";
import {
  CreateProposal,
  PROPOSAL_TTL_DAYS,
  ProposalPayload,
  proposalKind,
  proposalTarget,
  requiresApproval,
  type ApprovalChange,
} from "./index";

const SAM = "00000000-0000-4000-8000-00000000000a";
const JORDAN = "00000000-0000-4000-8000-00000000000b";
const GOAL = "00000000-0000-4000-8000-0000000000c1";

describe("requiresApproval (BACKEND_PLAN §7.3)", () => {
  const partnerItem = { ownerType: "member", ownerUserId: JORDAN } as const;
  const ownItem = { ownerType: "member", ownerUserId: SAM } as const;
  const itemChanges = [
    "item_delete",
    "item_owner",
    "item_status",
    "item_schedule",
    "occurrence_move",
    "occurrence_skip",
    "planned_delete",
    "planned_owner",
    "planned_move",
  ] as const;

  it.each(itemChanges)("%s needs approval only for the other member's item", (type) => {
    expect(requiresApproval({ type, ...partnerItem }, SAM)).toBe(true);
    expect(requiresApproval({ type, ...ownItem }, SAM)).toBe(false);
    expect(requiresApproval({ type, ownerType: "both", ownerUserId: null }, SAM)).toBe(false);
    expect(requiresApproval({ type, ownerType: "split", ownerUserId: null }, JORDAN)).toBe(false);
  });

  it("is symmetric: Jordan acting on Sam's item needs approval too", () => {
    expect(requiresApproval({ type: "item_delete", ...ownItem }, JORDAN)).toBe(true);
  });

  it("a goal's monthly amount needs approval whenever it changes, whoever made the goal", () => {
    expect(requiresApproval({ type: "goal_monthly", fromCents: 25000, toCents: 31300 }, SAM)).toBe(true);
    expect(requiresApproval({ type: "goal_monthly", fromCents: 25000, toCents: 0 }, SAM)).toBe(true);
    expect(requiresApproval({ type: "goal_monthly", fromCents: 25000, toCents: 25000 }, SAM)).toBe(false);
  });

  it("deleting a goal needs approval only while it still has a monthly amount", () => {
    expect(requiresApproval({ type: "goal_delete", monthlyCents: 30000 }, SAM)).toBe(true);
    expect(requiresApproval({ type: "goal_delete", monthlyCents: 0 }, SAM)).toBe(false);
  });

  it("covers every change type it declares", () => {
    const all: ApprovalChange["type"][] = ["goal_monthly", "goal_delete", ...itemChanges];
    expect(new Set(all).size).toBe(all.length);
  });

  it("proposals live for 7 days", () => {
    expect(PROPOSAL_TTL_DAYS).toBe(7);
  });
});

describe("proposal payloads", () => {
  it("round-trips a goal change with the engine's effect", () => {
    const payload = {
      type: "goal_monthly",
      goalId: GOAL,
      goalName: "Lake Tahoe trip",
      fromMonthlyCents: 25000,
      toMonthlyCents: 31300,
      effect: { safeToSpendBeforeCents: 100701, safeToSpendAfterCents: 100701 },
    };
    expect(ProposalPayload.parse(payload)).toEqual(payload);
    expect(proposalKind(ProposalPayload.parse(payload))).toBe("goal_change");
  });

  it("maps payload types to proposal kinds", () => {
    const kind = (type: string, extra: object = {}) =>
      proposalKind({ type, ...extra } as unknown as ProposalPayload);
    expect(kind("goal_delete")).toBe("goal_change");
    expect(kind("shortfall_move_bill")).toBe("shortfall_option");
    expect(kind("item_patch")).toBe("item_change");
    expect(kind("occurrence_move")).toBe("item_change");
    expect(kind("planned_delete")).toBe("item_change");
  });

  it("rejects fractional money and unknown payload types", () => {
    expect(
      ProposalPayload.safeParse({
        type: "goal_monthly",
        goalId: GOAL,
        goalName: "x",
        fromMonthlyCents: 1.5,
        toMonthlyCents: 2,
        effect: { safeToSpendBeforeCents: 0, safeToSpendAfterCents: 0 },
      }).success,
    ).toBe(false);
    expect(ProposalPayload.safeParse({ type: "move_money", amountCents: 100 }).success).toBe(false);
  });

  it("a client creates only goal and shortfall proposals, and names no number the plan uses", () => {
    expect(
      CreateProposal.safeParse({ type: "goal_monthly", goalId: GOAL, monthlyCents: 31300 }).success,
    ).toBe(true);
    expect(CreateProposal.safeParse({ type: "shortfall_option", option: "split_expense" }).success).toBe(
      true,
    );
    expect(CreateProposal.safeParse({ type: "shortfall_option", option: "pay_now" }).success).toBe(false);
    expect(CreateProposal.safeParse({ type: "item_delete", itemId: GOAL }).success).toBe(false);
  });
});

describe("goal contracts", () => {
  it("a deposit is positive, an adjustment may be negative, nothing is zero or fractional", () => {
    expect(CreateGoalEvent.safeParse({ kind: "deposit", amountCents: 25000 }).success).toBe(true);
    expect(CreateGoalEvent.safeParse({ kind: "deposit", amountCents: -1 }).success).toBe(false);
    expect(CreateGoalEvent.safeParse({ kind: "withdrawal", amountCents: -1 }).success).toBe(false);
    expect(CreateGoalEvent.safeParse({ kind: "adjustment", amountCents: -500 }).success).toBe(true);
    expect(CreateGoalEvent.safeParse({ kind: "adjustment", amountCents: 0 }).success).toBe(false);
    expect(CreateGoalEvent.safeParse({ kind: "deposit", amountCents: 10.5 }).success).toBe(false);
  });

  it("creating a goal fills defaults; patching never resets an omitted field", () => {
    const goal = CreateGoal.parse({ name: "Trip", type: "savings", targetCents: 100000 });
    expect(goal).toMatchObject({ savedCents: 0, monthlyCents: 0, colorSlot: 1, isEmergencyFund: false });
    expect(PatchGoal.parse({ name: "Trip 2" })).toEqual({ name: "Trip 2" });
    expect(PatchGoal.safeParse({}).success).toBe(false);
    expect(PatchGoal.safeParse({ status: "reached" }).success).toBe(false); // follows the saved amount
    expect(PatchGoal.safeParse({ savedCents: 5 }).success).toBe(false); // only events change it
  });
});

describe("task contracts", () => {
  it("a member owner needs an id; both and split must not have one", () => {
    expect(CreateTask.safeParse({ title: "x", ownerType: "both" }).success).toBe(true);
    expect(CreateTask.safeParse({ title: "x", ownerType: "member" }).success).toBe(false);
    expect(CreateTask.safeParse({ title: "x", ownerType: "both", ownerUserId: SAM }).success).toBe(false);
    expect(CreateTask.safeParse({ title: "x", ownerType: "member", ownerUserId: SAM }).success).toBe(true);
  });

  it("a client cannot name the source or an auto-complete rule", () => {
    expect(CreateTask.safeParse({ title: "x", ownerType: "both", source: "engine" }).success).toBe(false);
    expect(
      CreateTask.safeParse({ title: "x", ownerType: "both", autoCompleteRule: { type: "item_reviewed" } })
        .success,
    ).toBe(false);
  });

  it("patches need at least one field", () => {
    expect(PatchTask.safeParse({}).success).toBe(false);
    expect(PatchTask.safeParse({ completed: true }).success).toBe(true);
  });
});

describe("monthly-amount bypasses (security review H1, M2)", () => {
  it("archiving a goal needs approval only while it has a monthly amount", () => {
    expect(requiresApproval({ type: "goal_status", monthlyCents: 30000 }, SAM)).toBe(true);
    expect(requiresApproval({ type: "goal_status", monthlyCents: 0 }, JORDAN)).toBe(false);
  });

  it("taking money out needs approval for the emergency fund or a goal with a monthly amount", () => {
    expect(requiresApproval({ type: "goal_withdrawal", isEmergencyFund: true, monthlyCents: 0 }, SAM)).toBe(
      true,
    );
    expect(
      requiresApproval({ type: "goal_withdrawal", isEmergencyFund: false, monthlyCents: 100 }, JORDAN),
    ).toBe(true);
    expect(requiresApproval({ type: "goal_withdrawal", isEmergencyFund: false, monthlyCents: 0 }, SAM)).toBe(
      false,
    );
  });

  it("every payload names the one target the one-pending rule keys on", () => {
    const occ = "00000000-0000-4000-8000-0000000000d1";
    const item = "00000000-0000-4000-8000-0000000000d2";
    expect(
      proposalTarget({
        type: "occurrence_move",
        occurrenceId: occ,
        itemId: item,
      } as unknown as ProposalPayload),
    ).toBe(occ);
    expect(proposalTarget({ type: "item_delete", itemId: item } as unknown as ProposalPayload)).toBe(item);
    expect(proposalTarget({ type: "goal_status", goalId: GOAL } as unknown as ProposalPayload)).toBe(GOAL);
  });

  it("parses the new payloads", () => {
    const effect = { safeToSpendBeforeCents: 1, safeToSpendAfterCents: 1 };
    expect(
      ProposalPayload.safeParse({
        type: "goal_status",
        goalId: GOAL,
        goalName: "x",
        fromStatus: "active",
        toStatus: "archived",
        monthlyCents: 1,
        effect,
      }).success,
    ).toBe(true);
    expect(
      ProposalPayload.safeParse({
        type: "goal_withdrawal",
        goalId: GOAL,
        goalName: "x",
        kind: "withdrawal",
        amountCents: 5,
        occurredOn: "2026-11-01",
        note: null,
      }).success,
    ).toBe(true);
    expect(
      ProposalPayload.safeParse({ type: "goal_status", goalId: GOAL, toStatus: "reached" }).success,
    ).toBe(false);
  });
});
