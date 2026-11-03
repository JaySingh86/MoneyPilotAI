// Planning contracts (WP-12; BACKEND_PLAN §7.2, §8.2, §8.3): the plan, what-if, calendar, renewals and
// bills averages. Every number is produced by @mp/engine; these schemas only describe the wire shape, so
// the engine's result types are the source and this file mirrors them (an API test checks that nothing is
// dropped on the way out). Money is `Cents`, dates `IsoDate`; owners are a member's user id, `both` or `split`.
import { z } from "zod";
import { Cents, IsoDate, Uuid } from "../common";

/** A member's user id, `both` or `split`. */
const OwnerKey = z.string().min(1).max(64);
const OccurrenceStatus = z.enum(["scheduled", "paid", "received", "skipped"]);
const ItemSource = z.enum(["manual", "csv", "email", "bank"]);

/** `?asOf=` on the read endpoints. Default: the household's local today. */
const AsOfQuery = z.object({ asOf: IsoDate.optional() });

// ===== Plan =====
export const FlagCode = z.enum([
  "not_usual_month",
  "price_up",
  "possible_duplicate",
  "decide_by",
  "not_automatic",
  "estimate",
  "stale_balance",
  "overdue",
  /** An item has no known amount and is planned at $0 (WP-12, Q-107). `subjectId` is the item. */
  "data_missing",
]);

export const PlanFlag = z
  .object({
    code: FlagCode,
    /** The item (or renewal) the flag is about; null for household-level flags such as `stale_balance`. */
    subjectId: z.string().nullable(),
    date: IsoDate.nullable(),
    relatedIds: z.array(z.string()).optional(),
    deadlineKind: z.enum(["decision", "cancel"]).optional(),
  })
  .meta({ id: "PlanFlag" });

export const RunwayEvent = z
  .object({
    kind: z.enum(["income", "bill", "planned_expense", "goal_transfer"]),
    sourceId: z.string(),
    occurrenceId: Uuid.nullable(),
    name: z.string(),
    owner: OwnerKey,
    /** Signed: income is positive, money out is negative. */
    amountCents: Cents,
    date: IsoDate,
    scheduledOn: IsoDate,
    dueOn: IsoDate,
    status: z.union([OccurrenceStatus, z.literal("planned")]),
    isEstimate: z.boolean(),
  })
  .meta({ id: "RunwayEvent" });

export const RunwayDay = z
  .object({ date: IsoDate, endBalanceCents: Cents, events: z.array(RunwayEvent) })
  .meta({ id: "RunwayDay" });

export const PlanMathLine = z
  .object({
    id: z.enum([
      "starting_balance",
      "carried_events",
      "income_in_window",
      "money_out_in_window",
      "lowest_point",
      "cushion",
      "safe_to_spend",
      "shortfall",
      "days_to_payday",
      "per_day",
    ]),
    label: z.string(),
    role: z.enum(["value", "subtract", "total", "gap"]),
    cents: Cents.nullable(),
    days: z.number().int().nullable(),
    date: IsoDate.nullable(),
  })
  .meta({ id: "PlanMathLine" });

export const PlanDecision = z
  .object({
    id: z.string(),
    kind: z.enum(["shortfall", "not_usual_month", "estimate", "decide_by", "goal_behind"]),
    rank: z.number().int().min(1),
    subjectId: z.string().nullable(),
    owner: OwnerKey,
    date: IsoDate.nullable(),
    /** Card title template with `{param}` placeholders; the client fills them through packages/format. */
    templateText: z.string(),
    detailTemplateText: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    /** Reserved for the P1 Explain feature (WP-27); always null until then. */
    aiText: z.string().nullable(),
  })
  .meta({ id: "PlanDecision" });

export const OptionResult = z
  .object({
    state: z.enum(["on_track", "shortfall"]),
    safeToSpendCents: Cents,
    safeToSpendDisplayCents: Cents.nullable(),
    shortfallDisplayCents: Cents.nullable(),
    perDayCents: Cents.nullable(),
    minBalanceCents: Cents,
    neverBelowZero: z.boolean(),
    effect: z.enum(["ok", "info"]),
  })
  .meta({ id: "OptionResult" });

const ItemKind = z.enum([
  "bill",
  "subscription",
  "insurance",
  "membership",
  "registration",
  "loan",
  "income",
  "other",
]);

export const ShortfallOption = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("move_from_emergency_fund"),
      goalId: z.string(),
      amountCents: Cents,
      capped: z.boolean(),
      fundBalanceAfterCents: Cents,
      reachMonthBefore: z.string().nullable(),
      reachMonthAfter: z.string().nullable(),
      onlyIfAllowed: z.literal(false),
      result: OptionResult,
    }),
    z.object({
      kind: z.literal("split_expense"),
      plannedExpenseId: z.string(),
      amountNowCents: Cents,
      amountAfterPaydayCents: Cents,
      nowOn: IsoDate,
      afterPaydayOn: IsoDate,
      onlyIfAllowed: z.literal(true),
      result: OptionResult,
    }),
    z.object({
      kind: z.literal("move_bill_to_payday"),
      itemId: z.string(),
      itemKind: ItemKind,
      scheduledOn: IsoDate,
      fromDate: IsoDate,
      toDate: IsoDate,
      amountCents: Cents,
      onlyIfAllowed: z.literal(true),
      result: OptionResult,
    }),
  ])
  .meta({ id: "ShortfallOption" });

const Lowest = z.object({ date: IsoDate, balanceCents: Cents });

export const Plan = z
  .object({
    /**
     * The stored engine result this response is; "See the math" and Explain refer to it. Null when `asOf`
     * is not the household's local today: only today's plan is stored.
     */
    calcSnapshotId: Uuid.nullable(),
    engineVersion: z.string(),
    asOf: IsoDate,
    cushionCents: Cents,
    window: z.object({ from: IsoDate, to: IsoDate, daysToPayday: z.number().int() }),
    state: z.enum(["on_track", "shortfall"]),
    /** Lowest end-of-day balance minus the cushion; negative in a shortfall. */
    safeToSpendCents: Cents,
    /** Floored to whole dollars; null in a shortfall. */
    safeToSpendDisplayCents: Cents.nullable(),
    /** The shortfall rounded up to whole dollars (positive); null when on track. */
    shortfallDisplayCents: Cents.nullable(),
    perDayCents: Cents.nullable(),
    lowest: Lowest,
    belowCushionFrom: IsoDate.nullable(),
    belowZeroDates: z.array(IsoDate),
    billsBeforePayday: z.object({
      count: z.number().int(),
      totalCents: Cents,
      byOwner: z.record(z.string(), Cents),
    }),
    runway: z.array(RunwayDay),
    runwayDetail: z.object({
      startingBalanceCents: Cents,
      startingBalanceAsOf: IsoDate,
      carriedEvents: z.array(RunwayEvent),
      openingBalanceCents: Cents,
      excludedEvents: z.array(RunwayEvent),
    }),
    flags: z.array(PlanFlag),
    decisions: z.array(PlanDecision),
    /** Empty unless `state` is `shortfall`. */
    shortfallOptions: z.array(ShortfallOption),
    math: z.array(PlanMathLine),
  })
  .meta({ id: "Plan" });
export type Plan = z.infer<typeof Plan>;

export const PlanQuery = AsOfQuery;

// ===== What-if =====
export const MAX_WHAT_IF_CHANGES = 10;

export const PlanChange = z
  .discriminatedUnion("type", [
    /** "Pay on {date} instead": the occurrence moves, the series stays. */
    z.object({ type: z.literal("move_occurrence"), occurrenceId: Uuid, toDate: IsoDate }),
    /** The actual amount arrived (rule 6: it replaces the estimate). */
    z.object({
      type: z.literal("set_actual_amount"),
      occurrenceId: Uuid,
      amountCents: Cents.min(0),
    }),
    z.object({
      type: z.literal("split_planned_expense"),
      plannedExpenseId: Uuid,
      amountNowCents: Cents.min(1),
      laterOn: IsoDate,
    }),
    z.object({
      type: z.literal("add_transfer"),
      amountCents: Cents.min(1),
      on: IsoDate,
      fromGoalId: Uuid.nullish(),
    }),
    z.object({ type: z.literal("set_item_amount"), itemId: Uuid, amountCents: Cents.min(0) }),
    z.object({ type: z.literal("set_goal_monthly"), goalId: Uuid, monthlyCents: Cents.min(0) }),
  ])
  .meta({ id: "PlanChange" });
export type PlanChange = z.infer<typeof PlanChange>;

export const WhatIfRequest = z
  .object({
    changes: z.array(PlanChange).min(1).max(MAX_WHAT_IF_CHANGES),
    asOf: IsoDate.optional(),
  })
  .strict()
  .meta({ id: "WhatIfRequest" });
export type WhatIfRequest = z.infer<typeof WhatIfRequest>;

/** The headline of a plan, before or after a change. */
export const PlanSummary = z
  .object({
    state: z.enum(["on_track", "shortfall"]),
    safeToSpendCents: Cents,
    safeToSpendDisplayCents: Cents.nullable(),
    shortfallDisplayCents: Cents.nullable(),
    perDayCents: Cents.nullable(),
    lowest: Lowest,
    belowCushionFrom: IsoDate.nullable(),
    belowZeroDates: z.array(IsoDate),
    math: z.array(PlanMathLine),
  })
  .meta({ id: "PlanSummary" });

export const PlanDiff = z
  .object({
    stateBefore: z.enum(["on_track", "shortfall"]),
    stateAfter: z.enum(["on_track", "shortfall"]),
    safeToSpendBeforeCents: Cents,
    safeToSpendAfterCents: Cents,
    deltaCents: Cents,
    changesSafeToSpend: z.boolean(),
    lowestBefore: Lowest,
    lowestAfter: Lowest,
  })
  .meta({ id: "PlanDiff" });

export const WhatIfResponse = z
  .object({ before: PlanSummary, after: PlanSummary, diff: PlanDiff })
  .meta({ id: "WhatIfResponse" });
export type WhatIfResponse = z.infer<typeof WhatIfResponse>;

// ===== Calendar =====
export const CalendarEntry = z
  .object({
    kind: z.enum(["income", "bill", "estimate", "decision", "planned", "goal_transfer"]),
    sourceId: z.string(),
    occurrenceId: Uuid.nullable(),
    name: z.string(),
    owner: OwnerKey,
    amountCents: Cents,
    date: IsoDate,
    status: z.union([OccurrenceStatus, z.literal("planned")]),
    isEstimate: z.boolean(),
    flagCodes: z.array(FlagCode),
    goalIds: z.array(z.string()),
  })
  .meta({ id: "CalendarEntry" });

export const CalendarDay = z
  .object({ date: IsoDate, isPayday: z.boolean(), entries: z.array(CalendarEntry) })
  .meta({ id: "CalendarDay" });

export const CalendarMonth = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    days: z.array(CalendarDay),
    summary: z.object({
      incomeCents: Cents,
      billsCount: z.number().int(),
      billsCents: Cents,
      goalsAndPlannedCents: Cents,
      leftForEverydayCents: Cents,
      estimatesCount: z.number().int(),
    }),
  })
  .meta({ id: "CalendarMonth" });
export type CalendarMonth = z.infer<typeof CalendarMonth>;

export const CalendarQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
  owner: z.union([Uuid, z.enum(["both", "split"])]).optional(),
  asOf: IsoDate.optional(),
});

// ===== Renewals =====
export const RENEWAL_CATEGORIES = ["insurance", "subscription", "membership", "vehicle_home"] as const;
const RenewalCategory = z.enum(RENEWAL_CATEGORIES);

export const RenewalRow = z
  .object({
    id: z.string(),
    itemId: Uuid.nullable(),
    name: z.string(),
    category: RenewalCategory,
    owner: OwnerKey,
    amountCents: Cents,
    every: z.object({ unit: z.enum(["week", "month"]), n: z.number().int().min(1) }),
    annualCents: Cents,
    renewsOn: IsoDate,
    shopAroundOn: IsoDate,
    decisionBy: IsoDate.nullable(),
    actBy: IsoDate.nullable(),
    actByKind: z.enum(["decision", "cancel"]).nullable(),
    nextActionOn: IsoDate,
    autoRenews: z.enum(["yes", "no", "rolls_over"]),
    big: z.boolean(),
    reminderOffsetsDays: z.array(z.number().int()),
    priceUp: z.boolean(),
    annualIncreaseCents: Cents,
    markedPossiblyUnused: z.boolean(),
    sources: z.array(ItemSource),
    foundAutomatically: z.boolean(),
  })
  .meta({ id: "RenewalRow" });

export const RenewalList = z.object({ data: z.array(RenewalRow) }).meta({ id: "RenewalList" });
export const RenewalListQuery = z.object({ category: RenewalCategory.optional(), asOf: IsoDate.optional() });

export const RenewalsSummary = z
  .object({
    count: z.number().int(),
    yearlyCents: Cents,
    monthlyAverageCents: Cents,
    next90Days: z.object({
      count: z.number().int(),
      cents: Cents,
      planDecisions: z.number().int(),
      ids: z.array(z.string()),
    }),
    priceIncreaseYearlyCents: Cents,
    couldSaveYearlyCents: Cents,
    foundAutomatically: z.number().int(),
    countsByCategory: z.object({
      insurance: z.number().int(),
      subscription: z.number().int(),
      membership: z.number().int(),
      vehicle_home: z.number().int(),
    }),
  })
  .meta({ id: "RenewalsSummary" });
export type RenewalsSummary = z.infer<typeof RenewalsSummary>;

export const RenewalsSummaryQuery = AsOfQuery;

// ===== Bills averages (rule 17), returned on the items list with `?include=averages` =====
export const BillsAverages = z
  .object({
    /** Rows on Bills & recurring: active and paused items that are on the page. */
    rows: z.number().int(),
    monthlyBillsAverageCents: Cents,
    monthlyIncomeAverageCents: Cents,
    leftAfterBillsCents: Cents,
    estimatesToConfirm: z.number().int(),
    byItem: z.array(z.object({ itemId: Uuid, monthlyCents: Cents })),
  })
  .meta({ id: "BillsAverages" });
export type BillsAverages = z.infer<typeof BillsAverages>;
