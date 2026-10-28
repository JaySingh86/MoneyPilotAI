// Loads design/fixtures/rivera-household.json (the golden household) as an EngineInput.
// Test-only: production inputs come from the DB via the planning module.
import fixtureJson from "../../../../design/fixtures/rivera-household.json";
import type {
  EngineInput,
  GoalInput,
  ItemAmount,
  ItemInput,
  ItemKind,
  ItemSource,
  OccurrenceInput,
  PlannedExpenseInput,
  RenewalCategory,
  RenewalInput,
  Schedule,
  TaskInput,
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
  previousAmountCents?: number;
  priceChangedOn?: string;
  markedPossiblyUnused?: boolean;
  /** `csv`, `email`, or `email+csv`. */
  source?: string;
  subcategory?: string;
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
  emergencyFund?: boolean;
}

interface FixtureTask {
  id: string;
  title: string;
  owner: string;
  dueOn: string | null;
  dueHint?: string;
  completed: boolean;
}

interface FixtureRenewal {
  id: string;
  name: string;
  provider: string;
  category: string;
  amountCents: number;
  previousAmountCents?: number;
  frequency: string;
  renewsOn: string;
  decisionBy?: string;
  cancelBy?: string;
  owner: string;
  autoRenew: boolean | "rolls_over";
  source: string;
  markedPossiblyUnused?: boolean;
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

/** The `expected` keys checked by the WP-07 rules. */
export interface RiveraExpectedRules {
  electricityEstimate: { amountCents: number; rangeDisplay: string };
  tahoeGoal: {
    projectedByTargetCents: number;
    gapCents: number;
    suggestedMonthlyCents: number;
    alternativeTargetDate: string;
  };
  november: {
    incomeCents: number;
    billsCount: number;
    billsCents: number;
    goalsAndPlannedCents: number;
    leftForEverydayCents: number;
  };
  renewals: {
    count: number;
    yearlyCents: number;
    bigRenewalsNext90DaysCents: number;
    priceIncreaseYearlyCents: number;
    couldSaveYearlyCents: number;
    foundAutomatically: number;
  };
  billsPage: {
    rows: number;
    monthlyBillsAverageCents: number;
    monthlyIncomeAverageCents: number;
    leftAfterBillsCents: number;
    estimatesToConfirm: number;
  };
  goalsPage: {
    savingEachMonthCents: number;
    savedSoFarCents: number;
    effectOnSafeToSpendCents: number;
    emergency: { percent: number; status: string };
    tahoe: { percent: number; status: string; suggestedMonthlyCents: number };
    gifts: { percent: number; status: string; suggestedMonthlyCents: number };
  };
  tasks: { dueThisWeek: number; later: number; done: number; navBadge: number };
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

export type RiveraShortfallOptionExpected =
  | {
      id: "move-from-emergency";
      amountCents: number;
      safeToSpendCents: number;
      display: string;
      emergencyReachMonth: string;
    }
  | {
      id: "split-repair";
      amountNowCents: number;
      amountAfterPaydayCents: number;
      safeToSpendCents: number;
      display: string;
    }
  | { id: "car-insurance-on-payday"; safeToSpendCents: number; minBalanceCents: number; display: string };

export interface RiveraShortfallExpected extends RiveraShortfallExpectedCore {
  options: RiveraShortfallOptionExpected[];
}

export interface RiveraFixture {
  today: string;
  household: { id: string; timezone: string; cushionCents: number; primaryIncomeId: string };
  balance: { amountCents: number; asOf: string };
  incomes: FixtureItem[];
  bills: FixtureItem[];
  plannedExpenses: FixturePlannedExpense[];
  goals: FixtureGoal[];
  renewals: FixtureRenewal[];
  tasks: FixtureTask[];
  scenarios: {
    shortfall: { addPlannedExpenses: FixturePlannedExpense[]; expected: RiveraShortfallExpected };
  };
  expected: RiveraExpectedCore & RiveraExpectedRules;
}

/** The raw fixture, typed for the keys the engine uses. Treat as read-only. */
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

/** `email+csv` → `["email", "csv"]`. */
function parseSources(source: string | undefined): ItemSource[] {
  return source === undefined ? [] : source.split("+").map((s) => s as ItemSource);
}

/**
 * Renewals that are also recurring items (renewal_details is a 1:1 extension of recurring_items,
 * BACKEND_PLAN §5.2). The fixture has no link; r-car is the car insurance bill b-carins.
 */
const RENEWAL_ITEM_LINKS: Readonly<Record<string, string>> = { "r-car": "b-carins" };

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
    sources: parseSources(item.source),
    previousAmountCents: item.previousAmountCents ?? null,
    priceChangedOn: item.priceChangedOn ?? null,
    markedPossiblyUnused: item.markedPossiblyUnused ?? false,
    subcategory: item.subcategory ?? null,
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
    emergencyFund: g.emergencyFund ?? false,
  };
}

const RENEWAL_CATEGORIES: readonly RenewalCategory[] = [
  "insurance",
  "subscription",
  "membership",
  "vehicle_home",
];

function toRenewal(r: FixtureRenewal): RenewalInput {
  if (!RENEWAL_CATEGORIES.includes(r.category as RenewalCategory))
    throw new Error(`fixture ${r.id}: unknown category`);
  const frequency: Record<string, Pick<RenewalInput, "every" | "paidFrom">> = {
    "6_months": { every: { unit: "month", n: 6 }, paidFrom: "account" },
    monthly_payroll: { every: { unit: "month", n: 1 }, paidFrom: "payroll" },
    yearly: { every: { unit: "month", n: 12 }, paidFrom: "account" },
  };
  const f = frequency[r.frequency];
  if (!f) throw new Error(`fixture ${r.id}: unknown frequency`);
  return {
    id: r.id,
    itemId: RENEWAL_ITEM_LINKS[r.id] ?? null,
    name: r.name,
    category: r.category as RenewalCategory,
    owner: r.owner,
    amountCents: r.amountCents,
    ...f,
    renewsOn: r.renewsOn,
    autoRenews: r.autoRenew === "rolls_over" ? "rolls_over" : r.autoRenew ? "yes" : "no",
    sources: parseSources(r.source),
    previousAmountCents: r.previousAmountCents ?? null,
    priceChangedOn: null,
    markedPossiblyUnused: r.markedPossiblyUnused ?? false,
    subcategory: null,
    decisionBy: r.decisionBy ?? null,
    cancelBy: r.cancelBy ?? null,
  };
}

export interface RiveraOptions {
  scenario?: "base" | "shortfall";
  /** Defaults to the fixture's household timezone (America/New_York). */
  timezone?: string;
  occurrences?: OccurrenceInput[];
}

/** The fixture's household tasks (`tasks`), as engine input. */
export const RIVERA_TASKS: readonly TaskInput[] = riveraFixture.tasks.map((t) => ({
  id: t.id,
  title: t.title,
  owner: t.owner,
  dueOn: t.dueOn,
  completed: t.completed,
}));

/** The golden household as an EngineInput. Every call returns a fresh copy. */
export function riveraInput(options: RiveraOptions = {}): EngineInput {
  const f = riveraFixture;
  const planned = [...f.plannedExpenses];
  if (options.scenario === "shortfall") planned.push(...f.scenarios.shortfall.addPlannedExpenses);
  return {
    asOf: f.today,
    timezone: options.timezone ?? f.household.timezone,
    cushionCents: f.household.cushionCents,
    startingBalance: { cents: f.balance.amountCents, asOf: f.balance.asOf },
    primaryIncomeItemId: f.household.primaryIncomeId,
    items: [...f.incomes.map((i) => toItem(i, "inflow")), ...f.bills.map((b) => toItem(b, "outflow"))],
    occurrences: options.occurrences ? options.occurrences.map((o) => ({ ...o })) : [],
    plannedExpenses: planned.map(toPlannedExpense),
    goals: f.goals.map(toGoal),
    renewals: f.renewals.map(toRenewal),
  };
}
