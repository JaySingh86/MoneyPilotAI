// Loads design/fixtures/rivera-household.json (the golden household) as an EngineInput.
// Test-only: production inputs come from the DB via the planning module.
import fixtureJson from "../../../../design/fixtures/rivera-household.json";
import type {
  EngineInput,
  GoalInput,
  ItemAmount,
  ItemInput,
  ItemKind,
  OccurrenceInput,
  PlannedExpenseInput,
  Schedule,
  Weekday,
} from "../types";

type FixtureSchedule =
  | { type: "biweekly"; anchor: string }
  | { type: "monthly"; day: number | "last" }
  | { type: "monthly_last_weekday"; weekday: string }
  | { type: "every_n_months"; n: number; next: string };

interface FixtureItem {
  id: string;
  name: string;
  owner: string;
  amountCents?: number;
  estimate?: { historyCents?: number[]; fromLastStatementCents?: number };
  kind?: string;
  schedule: FixtureSchedule;
}

interface FixturePlannedExpense {
  id: string;
  name: string;
  owner: string;
  amountCents: number;
  date: string;
}

interface FixtureGoal {
  id: string;
  name: string;
  type?: string;
  targetCents: number;
  savedCents: number;
  monthlyCents?: number;
  targetDate?: string;
}

export interface RiveraExpectedCore {
  planningWindow: { from: string; to: string; daysToPayday: number };
  runwayEndOfDayCents: Record<string, number>;
  lowest: { date: string; balanceCents: number };
  safeToSpendCents: number;
  safeToSpendDisplay: string;
  perDayDisplay: string;
  billsBeforePayday: { count: number; totalCents: number; byOwner: Record<string, number> };
  safeToSpendIfCarInsuranceMovedToPaydayCents: number;
  safeToSpendAfterElectricityActual15137Cents: number;
}

export interface RiveraShortfallExpectedCore {
  runwayEndOfDayCents: Record<string, number>;
  lowest: { date: string; balanceCents: number };
  safeToSpendCents: number;
  heroDisplay: string;
  belowCushionFrom: string;
  belowZeroDates: string[];
  itemsBeforePayday: { count: number; totalCents: number };
}

export interface RiveraFixture {
  today: string;
  household: { id: string; cushionCents: number; primaryIncomeId: string };
  balance: { amountCents: number; asOf: string };
  incomes: FixtureItem[];
  bills: FixtureItem[];
  plannedExpenses: FixturePlannedExpense[];
  goals: FixtureGoal[];
  scenarios: {
    shortfall: { addPlannedExpenses: FixturePlannedExpense[]; expected: RiveraShortfallExpectedCore };
  };
  expected: RiveraExpectedCore;
}

/** The raw fixture, typed for the keys the engine core uses. Treat as read-only. */
export const riveraFixture = fixtureJson as unknown as RiveraFixture;

/**
 * Lower bound for the fixture's unanchored schedules (monthly on a day, last weekday), which carry no
 * start date. Any date on or before `today` gives the same window.
 */
export const RIVERA_SERIES_START = "2026-01-01";

const WEEKDAY_NAMES: readonly string[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function toSchedule(s: FixtureSchedule, itemId: string): Schedule {
  switch (s.type) {
    case "biweekly":
      return { type: "every_n_weeks", n: 2, dtstart: s.anchor };
    case "monthly":
      return s.day === "last"
        ? { type: "monthly_last_day", dtstart: RIVERA_SERIES_START }
        : { type: "monthly_day", day: s.day, dtstart: RIVERA_SERIES_START };
    case "monthly_last_weekday":
      if (!WEEKDAY_NAMES.includes(s.weekday)) throw new Error(`fixture ${itemId}: bad weekday`);
      return { type: "monthly_last_weekday", weekday: s.weekday as Weekday, dtstart: RIVERA_SERIES_START };
    case "every_n_months":
      return { type: "every_n_months", n: s.n, dtstart: s.next };
    default:
      throw new Error(`fixture ${itemId}: unknown schedule`);
  }
}

function toAmount(item: FixtureItem): ItemAmount {
  if (item.amountCents !== undefined) return { type: "fixed", cents: item.amountCents };
  if (item.estimate?.historyCents)
    return { type: "estimated", historyCents: [...item.estimate.historyCents] };
  if (item.estimate?.fromLastStatementCents !== undefined) {
    return { type: "statement", lastStatementCents: item.estimate.fromLastStatementCents };
  }
  throw new Error(`fixture ${item.id}: no amount`);
}

const KINDS: readonly ItemKind[] = [
  "bill",
  "subscription",
  "insurance",
  "membership",
  "registration",
  "loan",
  "income",
  "other",
];

function toItem(item: FixtureItem, direction: ItemInput["direction"]): ItemInput {
  const kind = (item.kind ?? (direction === "inflow" ? "income" : "bill")) as ItemKind;
  if (!KINDS.includes(kind)) throw new Error(`fixture ${item.id}: unknown kind`);
  return {
    id: item.id,
    name: item.name,
    direction,
    kind,
    owner: item.owner,
    amount: toAmount(item),
    schedule: toSchedule(item.schedule, item.id),
    weekendRule: "none",
    paidFrom: "account",
    status: "active",
  };
}

function toPlannedExpense(p: FixturePlannedExpense): PlannedExpenseInput {
  return {
    id: p.id,
    name: p.name,
    owner: p.owner,
    amountCents: p.amountCents,
    dueOn: p.date,
    status: "planned",
  };
}

function toGoal(g: FixtureGoal): GoalInput {
  return {
    id: g.id,
    name: g.name,
    type: g.type === "planned_expense" ? "planned_expense" : "savings",
    targetCents: g.targetCents,
    savedCents: g.savedCents,
    monthlyCents: g.monthlyCents ?? null,
    targetDate: g.targetDate ?? null,
  };
}

export interface RiveraOptions {
  scenario?: "base" | "shortfall";
  /** The fixture has no timezone; tests pick one. Defaults to America/Los_Angeles. */
  timezone?: string;
  occurrences?: OccurrenceInput[];
}

/** The golden household as an EngineInput. Every call returns a fresh copy. */
export function riveraInput(options: RiveraOptions = {}): EngineInput {
  const f = riveraFixture;
  const planned = [...f.plannedExpenses];
  if (options.scenario === "shortfall") planned.push(...f.scenarios.shortfall.addPlannedExpenses);
  return {
    asOf: f.today,
    timezone: options.timezone ?? "America/Los_Angeles",
    cushionCents: f.household.cushionCents,
    startingBalance: { cents: f.balance.amountCents, asOf: f.balance.asOf },
    primaryIncomeItemId: f.household.primaryIncomeId,
    items: [...f.incomes.map((i) => toItem(i, "inflow")), ...f.bills.map((b) => toItem(b, "outflow"))],
    occurrences: options.occurrences ? options.occurrences.map((o) => ({ ...o })) : [],
    plannedExpenses: planned.map(toPlannedExpense),
    goals: f.goals.map(toGoal),
  };
}
