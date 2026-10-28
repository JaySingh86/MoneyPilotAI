// Engine input and output (BACKEND_PLAN §7.2). Money is integer cents; dates are household-local ISO dates.
import type { IsoDate, Schedule, WeekendRule } from "./schedule/types";

export type { IsoDate, Schedule, WeekendRule, Weekday, ScheduleType } from "./schedule/types";

/** Integer cents, |x| < 2^53 (ADR-007). */
export type Cents = number;

/** A member id, or `both` / `split` for shared items (BACKEND_PLAN `owner_type`). */
export type OwnerKey = string;
export const OWNER_BOTH = "both";
export const OWNER_SPLIT = "split";

export type ItemKind =
  "bill" | "subscription" | "insurance" | "membership" | "registration" | "loan" | "income" | "other";

/** How an item's amount is known (BACKEND_PLAN §5.2 `amount_type`, DESIGN_SPEC §6 rule 6). */
export type ItemAmount =
  | { type: "fixed"; cents: Cents }
  /** Variable bill: amounts oldest → newest. The estimate is the mean of the last 3. */
  | { type: "estimated"; historyCents: Cents[] }
  /** Credit card: the last statement balance. */
  | { type: "statement"; lastStatementCents: Cents };

export interface ItemInput {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  kind: ItemKind;
  owner: OwnerKey;
  amount: ItemAmount;
  schedule: Schedule;
  /** Defaults to `none`. */
  weekendRule?: WeekendRule;
  /** `payroll` items are deducted before pay arrives and never touch the runway. Defaults to `account`. */
  paidFrom?: "account" | "payroll";
  /** Only `active` items produce scheduled occurrences. Defaults to `active`. */
  status?: "active" | "paused" | "ended" | "pending_review";
  // WP-07 (rules 8, 9, 11). All optional; the core plan ignores them.
  /** Where the item was found (BACKEND_PLAN `source`, plus amount-history sources). `manual` = added by hand. */
  sources?: ItemSource[];
  /** The previous term's amount, when the price changed (rule 8 price up, rule 11 price increases). */
  previousAmountCents?: Cents | null;
  priceChangedOn?: IsoDate | null;
  /** The household reviewed the price change; the price-up flag stops showing. */
  priceChangeReviewed?: boolean;
  /** Marked by the household; feeds "Could save" (rule 11). Never set by an algorithm. */
  markedPossiblyUnused?: boolean;
  /** Sub-category for the possible-duplicate flag (rule 8), e.g. `music`. */
  subcategory?: string | null;
  /**
   * Whether the payee might accept payment on a later date (shortfall option 3, rule 9). Defaults to true
   * for subscription, insurance, membership, registration and other items, and false for bill, loan and
   * income items, which usually carry hard due dates. See QUESTIONS.md Q-016.
   */
  movable?: boolean;
}

export type ItemSource = "manual" | "csv" | "email" | "bank";

export type OccurrenceStatus = "scheduled" | "paid" | "received" | "skipped";

/** A materialized occurrence (BACKEND_PLAN §5.2 `occurrences`). Missing ones are derived from the schedule. */
export interface OccurrenceInput {
  id?: string;
  itemId: string;
  /** The date from the rule. Identifies the occurrence within the series. */
  scheduledOn: IsoDate;
  /** After the weekend rule or a manual move. Defaults to the weekend-rule date. */
  dueOn?: IsoDate;
  status?: OccurrenceStatus;
  /** Replaces the item amount (or estimate) once known. */
  actualAmountCents?: Cents | null;
  /** When it was paid or received. Required for rule 7 on `paid` / `received`. */
  paidOn?: IsoDate | null;
}

export interface PlannedExpenseInput {
  id: string;
  name: string;
  owner: OwnerKey;
  amountCents: Cents;
  dueOn: IsoDate;
  /** Only `planned` expenses are projected. Defaults to `planned`. */
  status?: "planned" | "done" | "cancelled";
  goalId?: string | null;
}

export interface GoalInput {
  id: string;
  name: string;
  type?: "savings" | "planned_expense";
  targetCents: Cents;
  savedCents: Cents;
  /** Monthly deposit, made on the first primary payday of each month (rules 10, 16). */
  monthlyCents?: Cents | null;
  targetDate?: IsoDate | null;
  /** The household's emergency fund: the source for shortfall option 1 (DESIGN_SPEC §5.3). */
  emergencyFund?: boolean;
}

export type RenewalCategory = "insurance" | "subscription" | "membership" | "vehicle_home";

/**
 * Renewal details (BACKEND_PLAN §5.2 `renewal_details`, §7.5) for the renewals screen (rule 11) and the
 * renewal flags (rule 8). Active subscription items are added automatically (see `renewalList`).
 */
export interface RenewalInput {
  id: string;
  /** The recurring item this renewal belongs to, if it is in `items`; that item is then not listed twice. */
  itemId?: string | null;
  name: string;
  category: RenewalCategory;
  owner: OwnerKey;
  amountCents: Cents;
  /** Billing frequency: every `n` weeks or months. Yearly is `{ unit: "month", n: 12 }`. */
  every: { unit: "week" | "month"; n: number };
  renewsOn: IsoDate;
  /** `rolls_over`: continues unchanged if no choice is made (still automatic). */
  autoRenews: "yes" | "no" | "rolls_over";
  sources: ItemSource[];
  /** Deducted from pay (e.g. an employer health plan): in yearly totals, never in the runway. */
  paidFrom?: "account" | "payroll";
  previousAmountCents?: Cents | null;
  priceChangedOn?: IsoDate | null;
  priceChangeReviewed?: boolean;
  markedPossiblyUnused?: boolean;
  subcategory?: string | null;
  /** An enrollment or plan-choice deadline from email (rule 8 decide by). */
  decisionBy?: IsoDate | null;
  /** Cancel by this date to avoid the charge (rule 8 decide by). */
  cancelBy?: IsoDate | null;
}

/** A household task (BACKEND_PLAN §5.2 `tasks`, rule 15). */
export interface TaskInput {
  id: string;
  title: string;
  owner: OwnerKey;
  dueOn: IsoDate | null;
  /** True once completed, by a member or by its auto-complete rule. */
  completed: boolean;
}

export interface EngineInput {
  /** Household-local "today". The engine has no clock. */
  asOf: IsoDate;
  /** IANA zone of the household, e.g. `America/Los_Angeles`. */
  timezone: string;
  cushionCents: Cents;
  /** Latest known balance. Treated as the closing balance of `asOf` day (see QUESTIONS.md Q-006). */
  startingBalance: { cents: Cents; asOf: IsoDate };
  primaryIncomeItemId: string;
  items: ItemInput[];
  occurrences: OccurrenceInput[];
  plannedExpenses: PlannedExpenseInput[];
  goals: GoalInput[];
  /** Renewal details for rules 8 and 11 (WP-07). Optional; the core plan ignores them. */
  renewals?: RenewalInput[];
}

export type RunwayEventKind = "income" | "bill" | "planned_expense" | "goal_transfer";

export interface RunwayEvent {
  kind: RunwayEventKind;
  /** Item, planned expense or goal id. */
  sourceId: string;
  occurrenceId: string | null;
  name: string;
  owner: OwnerKey;
  /** Signed: income is positive, money out is negative. */
  amountCents: Cents;
  /** The date the money moves in the projection (`dueOn`, or `paidOn` once paid). */
  date: IsoDate;
  scheduledOn: IsoDate;
  dueOn: IsoDate;
  status: OccurrenceStatus | "planned";
  isEstimate: boolean;
}

export interface RunwayDay {
  date: IsoDate;
  endBalanceCents: Cents;
  events: RunwayEvent[];
}

export interface Runway {
  /** The latest known balance. */
  startingBalanceCents: Cents;
  startingBalanceAsOf: IsoDate;
  /** Events dated after the balance and before `asOf` that are applied before the first day (rule 7). */
  carriedEvents: RunwayEvent[];
  /** startingBalanceCents + carried events: the balance the first day starts from. */
  openingBalanceCents: Cents;
  days: RunwayDay[];
  /** Goal transfers on the final payday; they belong to the next window (rule 2). */
  excludedEvents: RunwayEvent[];
}

export interface PlanningWindow {
  from: IsoDate;
  /** The next primary payday on or after `from` (inclusive). */
  to: IsoDate;
  daysToPayday: number;
}

export type FlagCode =
  | "not_usual_month"
  | "price_up"
  | "possible_duplicate"
  | "decide_by"
  | "not_automatic"
  | "estimate"
  | "stale_balance"
  /** A materialized occurrence still `scheduled` but due before the balance date (QUESTIONS.md Q-006). */
  | "overdue";

export interface Flag {
  code: FlagCode;
  /** Item or occurrence the flag is about; null for household-level flags such as `stale_balance`. */
  subjectId: string | null;
  date: IsoDate | null;
  /** Every item in a possible-duplicate group, the subject included (WP-07). */
  relatedIds?: string[];
  /** `decide_by` only: a plan-choice deadline ("Decide by") or a cancel-by date ("Cancel by …?"). */
  deadlineKind?: "decision" | "cancel";
}

export type MathLineId =
  | "starting_balance"
  | "carried_events"
  | "income_in_window"
  | "money_out_in_window"
  | "lowest_point"
  | "cushion"
  | "safe_to_spend"
  | "shortfall"
  | "days_to_payday"
  | "per_day";

/** One row of "See the math" (DESIGN_SPEC §4 math breakdown). Values are raw; formatting is packages/format. */
export interface MathLine {
  id: MathLineId;
  label: string;
  /** `value` rows, `subtract` rows (shown with −), the `total` row, and the `gap` row in a shortfall. */
  role: "value" | "subtract" | "total" | "gap";
  cents: Cents | null;
  days: number | null;
  date: IsoDate | null;
}

export interface BillsBeforePayday {
  count: number;
  totalCents: Cents;
  byOwner: Record<OwnerKey, Cents>;
}

export interface PlanResult {
  engineVersion: string;
  asOf: IsoDate;
  window: PlanningWindow;
  runway: RunwayDay[];
  /** Starting balance, carried events and goal transfers left for the next window. */
  runwayDetail: Omit<Runway, "days">;
  /** Minimum end-of-day balance, excluding the final payday (rule 3). Earliest date wins a tie. */
  lowest: { date: IsoDate; balanceCents: Cents };
  state: "on_track" | "shortfall";
  /** lowest − cushion; may be negative (rule 4). */
  safeToSpendCents: Cents;
  /** Safe to spend floored to whole dollars; null in the shortfall state. */
  safeToSpendDisplayCents: Cents | null;
  /** The shortfall rounded up to whole dollars, as a positive amount; null when on track. */
  shortfallDisplayCents: Cents | null;
  /** Rule 5: floor to $5; null in the shortfall state. */
  perDayCents: Cents | null;
  /** First day below the cushion, excluding the final payday. */
  belowCushionFrom: IsoDate | null;
  /** Days that end below $0, excluding the final payday. */
  belowZeroDates: IsoDate[];
  billsBeforePayday: BillsBeforePayday;
  /** WP-02 raises `stale_balance` only; WP-07 adds the rule 8 flags. */
  flags: Flag[];
  math: MathLine[];
}

// ---- WP-07: what-if, decisions and shortfall options (DESIGN_SPEC §5.3, §6 rules 8–10) ----

/** One change for `whatIf` (rule 9, BACKEND_PLAN §7.2). */
export type PlanChange =
  /** "Pay on {date} instead": moves one occurrence; `scheduledOn` keeps the series intact (§7.1). */
  | { type: "move_occurrence"; itemId: string; scheduledOn: IsoDate; toDate: IsoDate }
  /** The actual amount of one occurrence arrived (rule 6: it replaces the estimate). */
  | { type: "set_actual_amount"; itemId: string; scheduledOn: IsoDate; amountCents: Cents }
  /** Splits a planned expense: `amountNowCents` stays on its date, the rest moves to `laterOn`. */
  | { type: "split_planned_expense"; plannedExpenseId: string; amountNowCents: Cents; laterOn: IsoDate }
  /** Money added to the account on `on`, optionally taken from a goal's saved amount. */
  | { type: "add_transfer"; amountCents: Cents; on: IsoDate; fromGoalId?: string | null }
  /** A new fixed amount for an item. */
  | { type: "set_item_amount"; itemId: string; amountCents: Cents }
  /** A new monthly deposit for a goal. */
  | { type: "set_goal_monthly"; goalId: string; monthlyCents: Cents };

/** Rule 9: the plan before and after a change. */
export interface PlanDiff {
  stateBefore: PlanResult["state"];
  stateAfter: PlanResult["state"];
  safeToSpendBeforeCents: Cents;
  safeToSpendAfterCents: Cents;
  deltaCents: Cents;
  /** The UI shows a "Pay on {date} instead" option only when this is true (rule 9). */
  changesSafeToSpend: boolean;
  lowestBefore: PlanResult["lowest"];
  lowestAfter: PlanResult["lowest"];
}

export interface WhatIfResult {
  /** The changed input, for proposals and snapshots. */
  input: EngineInput;
  plan: PlanResult;
  diff: PlanDiff;
}

export type DecisionKind = "shortfall" | "not_usual_month" | "estimate" | "decide_by" | "goal_behind";

/** A template parameter: money in `*Cents`, ISO dates in `*On` / `*Date`, months as `YYYY-MM`. */
export type DecisionParam = string | number | null;

/**
 * One "Decide this week" card. The text is a template with `{param}` placeholders that the UI fills
 * through packages/format, so every number comes from the engine (hard rule 4).
 */
export interface Decision {
  /** Stable key, e.g. `not_usual_month:b-carins:2026-11-04`. */
  id: string;
  kind: DecisionKind;
  /** 1 = first card. */
  rank: number;
  subjectId: string | null;
  owner: OwnerKey;
  date: IsoDate | null;
  /** The card title, e.g. `{name}, {amountCents} on {dueOn}`. */
  templateText: string;
  /** The card body. */
  detailTemplateText: string;
  params: Record<string, DecisionParam>;
}

/** The recalculated result of one shortfall option (rule 9). */
export interface OptionResult {
  state: PlanResult["state"];
  safeToSpendCents: Cents;
  safeToSpendDisplayCents: Cents | null;
  shortfallDisplayCents: Cents | null;
  perDayCents: Cents | null;
  /** The lowest end-of-day balance before payday. */
  minBalanceCents: Cents;
  neverBelowZero: boolean;
  /** Effect chip variant: ok when safe to spend ends up ≥ 0, info otherwise (DESIGN_SPEC §5.3). */
  effect: "ok" | "info";
}

/** "Ways to cover the gap", in the spec's fixed order (DESIGN_SPEC §5.3). */
export type ShortfallOption =
  | {
      kind: "move_from_emergency_fund";
      goalId: string;
      amountCents: Cents;
      /** True when the amount was capped at the fund balance. */
      capped: boolean;
      fundBalanceAfterCents: Cents;
      /** `YYYY-MM` the fund reaches its target before and after the move; null if it never does. */
      reachMonthBefore: string | null;
      reachMonthAfter: string | null;
      onlyIfAllowed: false;
      result: OptionResult;
    }
  | {
      kind: "split_expense";
      plannedExpenseId: string;
      amountNowCents: Cents;
      amountAfterPaydayCents: Cents;
      nowOn: IsoDate;
      /** The day after payday. */
      afterPaydayOn: IsoDate;
      /** "Only if … allows it": a third party decides. */
      onlyIfAllowed: true;
      result: OptionResult;
    }
  | {
      kind: "move_bill_to_payday";
      itemId: string;
      itemKind: ItemKind;
      scheduledOn: IsoDate;
      fromDate: IsoDate;
      toDate: IsoDate;
      amountCents: Cents;
      onlyIfAllowed: true;
      result: OptionResult;
    };

/** The core plan plus rule 8 flags, ranked decisions and shortfall options (BACKEND_PLAN §7.2). */
export interface FullPlanResult extends PlanResult {
  decisions: Decision[];
  /** Empty unless `state` is `shortfall`. */
  shortfallOptions: ShortfallOption[];
}
