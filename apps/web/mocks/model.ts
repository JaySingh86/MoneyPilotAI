// The mock planning API's brain: runs the engine on the golden fixture (design/fixtures/rivera-household.json)
// and shapes the result as the web's planning types. Dev and tests only (see lib/config.ts).
// This is where WP-12's service layer will sit, with the database in place of the fixture.
import { calendarMonth, computeFullPlan, estimate, goalsSummary, tasksDueThisWeek } from "@mp/engine";
import type { CalendarEntry, EngineInput, FullPlanResult, ItemInput, TaskInput } from "@mp/engine";
import { RIVERA_TASKS, riveraFixture, riveraInput } from "@mp/engine/testing";
import type {
  CalendarEntryDto,
  Goal,
  Task,
  CalendarResponse,
  DueRowDto,
  PlanResponse,
  RunwayDay,
  RunwayEvent,
} from "../lib/api/planning-types";
import { HOUSEHOLD_ID, JORDAN_ID, OWNER_IDS, SAM_ID } from "./identity";

/** When the fixture's October bank CSV was imported: its "Import October bank CSV" task (d1) is done that day. */
const CSV_IMPORTED_ON = riveraFixture.tasks.find((t) => t.id === "d1")?.dueOn ?? riveraFixture.balance.asOf;

export type Scenario = "base" | "shortfall" | "empty";

export const owner = (key: string): string => OWNER_IDS[key] ?? key;
/** Member ids the API accepts in `?owner=`, mapped back to the fixture's. */
const FIXTURE_OWNER: Readonly<Record<string, string>> = { [SAM_ID]: "m-sam", [JORDAN_ID]: "m-jordan" };

/** Short names under the runway bars (the canvas draws "Rent", "Daycare & TV"). */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  "b-car": "Car",
  "b-phone": "Phone",
  "b-rent": "Rent",
  "b-daycare": "Daycare",
  "b-stream": "TV",
  "b-power": "Power",
  "b-carins": "Insurance",
  "b-internet": "Internet",
  "inc-sam": "Pay",
  "inc-jordan": "Pay",
  "p-repair": "Repair",
};

const SCHEDULE_LABELS: Readonly<Record<string, string>> = {
  "inc-sam": "Biweekly, every other Friday",
  "inc-jordan": "Monthly, last Friday of the month",
};

export function input(scenario: Scenario): EngineInput {
  if (scenario !== "empty") return riveraInput({ scenario });
  // A household that has only just signed up: paychecks, no bills, goals, tasks or planned expenses.
  const base = riveraInput();
  return {
    ...base,
    items: base.items.filter((i) => i.direction === "inflow"),
    plannedExpenses: [],
    goals: [],
    renewals: [],
  };
}

function tasksFor(scenario: Scenario): readonly TaskInput[] {
  return scenario === "empty" ? [] : RIVERA_TASKS;
}

function frequencyLabel(item: ItemInput): string {
  const s = item.schedule;
  if (s.type === "every_n_months") return s.n === 3 ? "Quarterly" : `Every ${s.n} months`;
  if (s.type === "yearly") return "Yearly";
  if (item.amount.type === "estimated") return "Monthly · varies";
  return item.kind === "subscription" ? "Monthly · subscription" : "Monthly";
}

function itemMap(i: EngineInput): Map<string, ItemInput> {
  return new Map(i.items.map((x) => [x.id, x]));
}

const remapEvent = (e: FullPlanResult["runway"][number]["events"][number]): RunwayEvent => ({
  ...e,
  owner: owner(e.owner),
});

function runwayDays(plan: FullPlanResult): RunwayDay[] {
  return plan.runway.map((day) => ({ ...day, events: day.events.map(remapEvent) }));
}

/** MOCK-ONLY: short names under the runway bars, by date (Q-091). */
function runwayLabels(plan: FullPlanResult): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const day of plan.runway) {
    if (day.events.length === 0) continue;
    labels[day.date] = [...new Set(day.events.map((e) => SHORT_NAMES[e.sourceId] ?? e.name))].join(" & ");
  }
  return labels;
}

function dueRows(plan: FullPlanResult, engineInput: EngineInput): DueRowDto[] {
  const items = itemMap(engineInput);
  return plan.runway
    .filter((d) => d.date < plan.window.to)
    .flatMap((d) => d.events)
    .filter((e) => e.kind === "bill" || e.kind === "planned_expense")
    .map((e): DueRowDto => {
      const item = items.get(e.sourceId);
      const flags: DueRowDto["flags"] = [];
      if (plan.flags.some((f) => f.code === "price_up" && f.subjectId === e.sourceId)) flags.push("price_up");
      if (
        plan.flags.some(
          (f) => f.code === "not_usual_month" && f.subjectId === e.sourceId && f.date === e.dueOn,
        )
      )
        flags.push("not_usual_month");
      const amount = -e.amountCents;
      const previous = item?.previousAmountCents ?? null;
      return {
        id: `${e.sourceId}:${e.dueOn}`,
        sourceId: e.sourceId,
        kind: e.kind === "bill" ? "bill" : "planned_expense",
        name: e.name,
        dueOn: e.dueOn,
        frequencyLabel: item ? frequencyLabel(item) : "One time",
        owner: owner(e.owner),
        amountCents: amount,
        isEstimate: e.isEstimate,
        estimateRangeCents: item && e.isEstimate ? estimate(item).rangeCents : null,
        flags,
        priceUpCents: flags.includes("price_up") && previous !== null ? amount - previous : null,
      };
    });
}

const CREATED_AT = "2026-10-20T14:00:00Z";

export function goalRows(engineInput: EngineInput): Goal[] {
  if (engineInput.goals.length === 0) return [];
  return goalsSummary(engineInput).goals.map((g, i) => ({
    id: g.goalId,
    householdId: HOUSEHOLD_ID,
    name: g.name,
    type: g.type,
    targetCents: g.targetCents,
    savedCents: g.savedCents,
    monthlyCents: g.monthlyCents,
    targetDate: g.targetDate,
    colorSlot: Math.min(i + 1, 3),
    isEmergencyFund: engineInput.goals.find((x) => x.id === g.goalId)?.emergencyFund ?? false,
    status: g.status === "reached" ? "reached" : "active",
    progress: {
      status: g.status,
      percent: g.percent,
      remainingCents: g.remainingCents,
      reachMonth: g.reachMonth,
      contributionsByTarget: g.contributionsByTarget,
      projectedByTargetCents: g.projectedByTargetCents,
      gapCents: g.gapCents,
      suggestedMonthlyCents: g.suggestedMonthlyCents,
      alternativeTargetDate: g.alternativeTargetDate,
    },
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }));
}

function taskDto(t: TaskInput): Task {
  const hint = riveraFixture.tasks.find((x) => x.id === t.id)?.dueHint ?? null;
  const key = owner(t.owner);
  return {
    id: t.id,
    householdId: HOUSEHOLD_ID,
    title: t.title,
    ownerType: key === "both" || key === "split" ? key : "member",
    ownerUserId: key === "both" || key === "split" ? null : key,
    dueOn: t.dueOn,
    dueHint: hint,
    linkedItemId: null,
    linkedItemName: null,
    source: "user",
    autoCompleteRule: null,
    completed: t.completed,
    completedAt: t.completed ? CREATED_AT : null,
    completedBy: null,
    completedReason: null,
    version: 1,
    createdBy: null,
    createdAt: CREATED_AT,
  };
}

/** `GET /households/:hid/plan` for the fixture household. */
export function buildPlan(scenario: Scenario): PlanResponse {
  const engineInput = input(scenario);
  const plan = computeFullPlan(engineInput);
  const groups = tasksDueThisWeek(tasksFor(scenario), plan.asOf);
  return {
    // The contract's Plan: the engine's result, with owners as member ids and `aiText` reserved for WP-27.
    calcSnapshotId: `00000000-0000-4000-8000-0000000000${scenario === "base" ? "01" : scenario === "shortfall" ? "02" : "03"}`,
    engineVersion: plan.engineVersion,
    asOf: plan.asOf,
    cushionCents: engineInput.cushionCents,
    window: plan.window,
    state: plan.state,
    safeToSpendCents: plan.safeToSpendCents,
    safeToSpendDisplayCents: plan.safeToSpendDisplayCents,
    shortfallDisplayCents: plan.shortfallDisplayCents,
    perDayCents: plan.perDayCents,
    lowest: plan.lowest,
    belowCushionFrom: plan.belowCushionFrom,
    belowZeroDates: plan.belowZeroDates,
    billsBeforePayday: {
      count: plan.billsBeforePayday.count,
      totalCents: plan.billsBeforePayday.totalCents,
      byOwner: Object.fromEntries(
        Object.entries(plan.billsBeforePayday.byOwner).map(([k, v]) => [owner(k), v]),
      ),
    },
    runway: runwayDays(plan),
    runwayDetail: {
      ...plan.runwayDetail,
      carriedEvents: plan.runwayDetail.carriedEvents.map(remapEvent),
      excludedEvents: plan.runwayDetail.excludedEvents.map(remapEvent),
    },
    flags: plan.flags,
    decisions: plan.decisions.map((d) => ({ ...d, owner: owner(d.owner), aiText: null })),
    shortfallOptions: plan.shortfallOptions,
    math: plan.math,
    // MOCK-ONLY from here (see planning-types.ts).
    runwayLabels: runwayLabels(plan),
    dueBeforePayday: dueRows(plan, engineInput),
    goals: goalRows(engineInput),
    tasks: {
      dueThisWeek: groups.dueThisWeek.map(taskDto),
      recentlyDone: groups.done.slice(0, 1).map(taskDto),
    },
    dataSource: { isSample: true, label: "CSV import", updatedOn: CSV_IMPORTED_ON },
  };
}

/** The nav badge: open tasks due within 7 days (rule 15). */
export function tasksDueBadge(scenario: Scenario): number {
  return tasksDueThisWeek(tasksFor(scenario), input(scenario).asOf).navBadge;
}

function calendarEntry(e: CalendarEntry, engineInput: EngineInput): CalendarEntryDto {
  const item = itemMap(engineInput).get(e.sourceId);
  const goals = e.goalIds.flatMap((id) => {
    const g = engineInput.goals.find((x) => x.id === id);
    return g ? [{ name: g.name, amountCents: g.monthlyCents ?? 0 }] : [];
  });
  const est = item && e.isEstimate ? estimate(item) : null;
  const scheduleLabel = SCHEDULE_LABELS[e.sourceId] ?? (item ? frequencyLabel(item) : null);
  return {
    kind: e.kind,
    sourceId: e.sourceId,
    occurrenceId: e.occurrenceId,
    name: e.kind === "goal_transfer" ? "Goal transfer" : e.name,
    owner: owner(e.owner),
    amountCents: e.amountCents,
    date: e.date,
    status: e.status,
    isEstimate: e.isEstimate,
    flagCodes: e.flagCodes,
    goalIds: e.goalIds,
    scheduleLabel,
    estimate: est ? { historyCents: est.historyCents, minCents: est.minCents, maxCents: est.maxCents } : null,
    priceChange:
      e.flagCodes.includes("price_up") && item?.previousAmountCents != null
        ? { previousCents: item.previousAmountCents, currentCents: -e.amountCents }
        : null,
    everyMonths:
      item && e.flagCodes.includes("not_usual_month") && item.schedule.type === "every_n_months"
        ? item.schedule.n
        : null,
    goalDeposits: goals,
  };
}

/** `GET /households/:hid/calendar?month=&owner=`. `ownerId` is a member user id, or undefined for everyone. */
export function buildCalendar(scenario: Scenario, month: string, ownerId?: string): CalendarResponse {
  const engineInput = input(scenario);
  const filter = ownerId ? (FIXTURE_OWNER[ownerId] ?? ownerId) : null;
  const cal = calendarMonth(engineInput, month, { owner: filter });
  const days = cal.days.map((d) => ({
    date: d.date,
    isPayday: d.isPayday,
    entries: d.entries.map((e) => calendarEntry(e, engineInput)),
  }));
  return {
    month: cal.month,
    days,
    summary: cal.summary,
    // MOCK-ONLY
    reminderOffsetsDays: [3, 0],
  };
}
