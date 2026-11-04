// What the web app reads from the planning API.
//
// The contract is `@mp/contracts` (WP-12, `packages/contracts/src/planning`): the plan is the engine's
// FullPlanResult and the calendar is its CalendarMonth. `PlanResponse` and `CalendarResponse` are those
// contract types plus the fields the canvas needs that the contract does not carry yet. Every such
// field is marked MOCK-ONLY below: the MSW mock (apps/web/mocks) serves it, a real API does not, and
// each one is a gap for WP-18 to wire from the items, goals and tasks endpoints (see Q-096).
//
// The web never imports the engine (ARCHITECTURE §3). Types from @mp/contracts are fine.
import type { CalendarMonth, Goal, Plan, Task } from "@mp/contracts";

export type {
  CalendarMonth,
  Plan,
  PlanChange,
  WhatIfResponse,
  RenewalsSummary,
  BillsAverages,
  Goal,
  Task,
} from "@mp/contracts";

/** A member's user id, or `both` / `split` for shared items. */
export type OwnerId = string;

export type RunwayDay = Plan["runway"][number];
export type RunwayEvent = RunwayDay["events"][number];
export type Decision = Plan["decisions"][number];
export type DecisionKind = Decision["kind"];
export type ShortfallOption = Plan["shortfallOptions"][number];
export type OptionResult = ShortfallOption["result"];
export type MathLine = Plan["math"][number];

/**
 * MOCK-ONLY. One row of "Due before payday": a bill or a planned expense dated in the window, with
 * the display metadata the table needs. Today a client would build it from `runway` events plus
 * `GET /items`; WP-18 wires that (Q-096).
 */
export interface DueRowDto {
  id: string;
  /** The item or planned expense id, to look up names for the shortfall options. */
  sourceId: string;
  kind: "bill" | "planned_expense";
  name: string;
  dueOn: string;
  /** "Monthly", "Every 6 months", "Monthly · varies", "Monthly · subscription", "One time". */
  frequencyLabel: string;
  owner: OwnerId;
  amountCents: number;
  isEstimate: boolean;
  /** Estimate range (rule 6) for the "Estimate ±$30" chip. */
  estimateRangeCents: number | null;
  /** Rule 8 flags that set the status chip (the contract's `flags`, joined to the row). */
  flags: Array<"price_up" | "not_usual_month">;
  /** New amount minus the previous term's, when `price_up`. */
  priceUpCents: number | null;
}

/**
 * The contract's plan plus the MOCK-ONLY fields: the short runway names ("Rent", "Daycare & TV",
 * keyed by date, Q-091), the due rows, the household's goals and tasks (the `Goal` and `Task`
 * contracts of WP-13, served by the goals and tasks endpoints, not by the plan) and the data-source
 * freshness.
 */
export type PlanResponse = Plan & {
  /** MOCK-ONLY. Short name under each runway bar, by date; the web falls back to the event's name. */
  runwayLabels: Record<string, string>;
  /** MOCK-ONLY. */
  dueBeforePayday: DueRowDto[];
  /** MOCK-ONLY on the plan: from `GET /goals` (WP-13). */
  goals: Goal[];
  /** MOCK-ONLY on the plan: from `GET /tasks` (WP-13): due within 7 days (rule 15) and the latest done. */
  tasks: { dueThisWeek: Task[]; recentlyDone: Task[] };
  /** MOCK-ONLY. Data freshness for the footer (DESIGN_SPEC §5.3 stale data). */
  dataSource: { isSample: boolean; label: string; updatedOn: string };
};

// ---- Calendar (GET /households/:hid/calendar?month=2026-11&owner=) ----

export type CalendarEntryKind = CalendarMonth["days"][number]["entries"][number]["kind"];

/** The contract's entry plus MOCK-ONLY details for the selected-day notes. */
export type CalendarEntryDto = CalendarMonth["days"][number]["entries"][number] & {
  /** MOCK-ONLY. Income and bills: "Biweekly, every other Friday", "Quarterly". */
  scheduleLabel: string | null;
  /** MOCK-ONLY. Estimates (rule 6). */
  estimate: { historyCents: number[]; minCents: number | null; maxCents: number | null } | null;
  /** MOCK-ONLY. `price_up` flag: the amounts before and after. */
  priceChange: { previousCents: number; currentCents: number } | null;
  /** MOCK-ONLY. `not_usual_month` flag: the billing interval. */
  everyMonths: number | null;
  /** MOCK-ONLY. `goal_transfer`: the deposits it reminds about. */
  goalDeposits: Array<{ name: string; amountCents: number }>;
};

export type CalendarDayDto = Omit<CalendarMonth["days"][number], "entries"> & {
  entries: CalendarEntryDto[];
};

export type CalendarResponse = Omit<CalendarMonth, "days"> & {
  days: CalendarDayDto[];
  /** MOCK-ONLY. Household reminder offsets in days before the due date (WP-15). */
  reminderOffsetsDays: number[];
};
