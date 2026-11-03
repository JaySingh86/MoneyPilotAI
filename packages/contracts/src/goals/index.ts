// Goals, goal events and goal options (WP-13; BACKEND_PLAN §5.2, §7.3, §8.2; DESIGN_SPEC §5.1 Goals,
// §6 rules 10 and 16). Status, percent, suggestions and options are computed by `@mp/engine` and only
// carried here; MoneyPilot never moves money, so deposits are recorded by the user.
import { z } from "zod";
import { Cents, IsoDate, Timestamp, Uuid, Version } from "../common";
import { MAX_MONEY_CENTS } from "../items";
import { Proposal } from "../proposals";

const Money = Cents.min(0).max(MAX_MONEY_CENTS);

export const GOAL_TYPES = ["savings", "planned_expense"] as const;
export const GOAL_STATUS_KINDS = [
  "reached",
  "reach_month",
  "no_monthly_amount",
  "unreachable",
  "on_track",
  "behind",
  "to_set_aside",
] as const;

/** The engine's `goalStatus` for a goal (rules 10 and 16). */
export const GoalProgress = z
  .object({
    status: z.enum(GOAL_STATUS_KINDS),
    /** Saved ÷ target, at most 100, and 100 only when reached. */
    percent: z.number().int().min(0).max(100),
    remainingCents: Money,
    /** `YYYY-MM` of the deposit that reaches the target at the current amount. */
    reachMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullable(),
    contributionsByTarget: z.number().int().min(0).nullable(),
    projectedByTargetCents: Money.nullable(),
    gapCents: Money.nullable(),
    suggestedMonthlyCents: Money.nullable(),
    alternativeTargetDate: IsoDate.nullable(),
  })
  .meta({ id: "GoalProgress" });
export type GoalProgress = z.infer<typeof GoalProgress>;

export const Goal = z
  .object({
    id: Uuid,
    householdId: Uuid,
    name: z.string().min(1).max(80),
    type: z.enum(GOAL_TYPES),
    targetCents: Money,
    savedCents: Money,
    monthlyCents: Money,
    targetDate: IsoDate.nullable(),
    colorSlot: z.number().int().min(1).max(3),
    isEmergencyFund: z.boolean(),
    status: z.enum(["active", "reached", "archived"]),
    progress: GoalProgress,
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Goal" });
export type Goal = z.infer<typeof Goal>;

/** `GET …/goals`: the KPI row and the goal cards. Archived goals are not listed (`GET …/goals/:id` still reads one). */
export const GoalList = z
  .object({
    /** The sum of monthly deposits of goals not yet reached ("Saving each month"). */
    savingEachMonthCents: Money,
    savedSoFarCents: Money,
    /** Safe to spend with goal transfers minus without them (0 when they land on payday). */
    effectOnSafeToSpendCents: Cents,
    /** The next transfer reminder: the first primary payday of the next month with a deposit. */
    nextTransferOn: IsoDate.nullable(),
    data: z.array(Goal),
  })
  .meta({ id: "GoalList" });

/**
 * `POST …/goals` with a monthly amount when someone else can approve: the goal is created with a monthly
 * amount of 0 and a pending `goal_monthly` proposal for the requested amount (202). The screen shows
 * "waiting for {partner}".
 */
export const CreateGoalPending = z
  .object({ goal: Goal, proposal: Proposal })
  .meta({ id: "CreateGoalPending" });

export const GoalParams = z.object({ hid: Uuid, id: Uuid });

const goalFields = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(GOAL_TYPES),
  targetCents: Money.min(1),
  monthlyCents: Money,
  targetDate: IsoDate.nullish(),
  colorSlot: z.number().int().min(1).max(3),
});

/**
 * `POST …/goals`. A new goal starts with the saved amount the household says it has; later deposits are
 * recorded as events. At most one goal is the emergency fund.
 */
export const CreateGoal = goalFields
  .extend({
    savedCents: Money.default(0),
    monthlyCents: goalFields.shape.monthlyCents.default(0),
    colorSlot: goalFields.shape.colorSlot.default(1),
    isEmergencyFund: z.boolean().default(false),
  })
  .strict()
  .meta({ id: "CreateGoal" });
export type CreateGoal = z.infer<typeof CreateGoal>;

/**
 * `PATCH …/goals/:id` with `If-Match`. Changing `monthlyCents` changes the shared plan, so it returns 202
 * with a proposal the other member approves; the other fields apply at once.
 */
export const PatchGoal = goalFields
  .omit({ type: true })
  .extend({ status: z.enum(["active", "archived"]) })
  .strict()
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field")
  .meta({ id: "PatchGoal" });
export type PatchGoal = z.infer<typeof PatchGoal>;

export const GOAL_EVENT_KINDS = ["deposit", "withdrawal", "adjustment"] as const;

export const GoalEvent = z
  .object({
    id: Uuid,
    goalId: Uuid,
    kind: z.enum(GOAL_EVENT_KINDS),
    /** Positive for a deposit or withdrawal; signed for an adjustment. */
    amountCents: Cents,
    occurredOn: IsoDate,
    note: z.string().nullable(),
    recordedBy: Uuid.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "GoalEvent" });
export type GoalEvent = z.infer<typeof GoalEvent>;

/** `POST …/goals/:id/events`: the household says money went in or out of the goal. Nothing is transferred. */
export const CreateGoalEvent = z
  .object({
    kind: z.enum(GOAL_EVENT_KINDS),
    amountCents: Cents.min(-MAX_MONEY_CENTS).max(MAX_MONEY_CENTS),
    /** Defaults to today in the household's time zone. */
    occurredOn: IsoDate.optional(),
    note: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.amountCents !== 0, { message: "The amount can't be zero", path: ["amountCents"] })
  .refine((v) => v.kind === "adjustment" || v.amountCents > 0, {
    message: "A deposit or withdrawal is a positive amount",
    path: ["amountCents"],
  })
  .meta({ id: "CreateGoalEvent" });
export type CreateGoalEvent = z.infer<typeof CreateGoalEvent>;

export const GoalEventResult = z.object({ event: GoalEvent, goal: Goal }).meta({ id: "GoalEventResult" });

/** Rule 10: the ways to close a gap. */
export const GoalOption = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("raise_monthly"), monthlyCents: Money }),
    z.object({ kind: z.literal("move_date"), targetDate: IsoDate }),
    z.object({ kind: z.literal("lower_target"), targetCents: Money }),
  ])
  .meta({ id: "GoalOption" });
export type GoalOption = z.infer<typeof GoalOption>;

/** `GET …/goals/:id/options`: empty unless the goal is behind (or has a planned expense to set aside). */
export const GoalOptions = z
  .object({ goalId: Uuid, status: z.enum(GOAL_STATUS_KINDS), options: z.array(GoalOption) })
  .meta({ id: "GoalOptions" });
export type GoalOptions = z.infer<typeof GoalOptions>;
