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
}

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
  | "stale_balance";

export interface Flag {
  code: FlagCode;
  /** Item or occurrence the flag is about; null for household-level flags such as `stale_balance`. */
  subjectId: string | null;
  date: IsoDate | null;
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
