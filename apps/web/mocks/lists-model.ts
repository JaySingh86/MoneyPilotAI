// The mock API for Bills, Renewals, Goals and Tasks (WP-18): the WP-06, WP-12 and WP-13 contracts served
// from the golden fixture through the engine. Every number comes from `@mp/engine`; the shapes are the
// `@mp/contracts` ones (mocks/lists.test.ts parses every response with the contract schemas). Ids are the
// fixture's ("b-power", "g-tahoe") so they match the plan mock's flags and decisions.
import {
  billsAverages,
  expandSchedule,
  estimate,
  goalStatus,
  goalsSummary,
  parseDate,
  renewalsSummary,
  tasksDueThisWeek,
  whatIf,
} from "@mp/engine";
import type { EngineInput, GoalInput, ItemInput, TaskInput } from "@mp/engine";
import { riveraFixture } from "@mp/engine/testing";
import { money } from "@mp/format";
import type {
  BillsAverages,
  Goal,
  GoalOptions,
  Item,
  PlannedExpense,
  Proposal,
  RenewalsSummary,
  Task,
} from "@mp/contracts";
import type { components } from "@mp/contracts/client";
import type { GoalPreview } from "../lib/lists/hooks";
import { HOUSEHOLD_ID, JORDAN_ID, SAM_ID } from "./identity";
import { goalRows, input, owner } from "./model";
import type { Scenario } from "./model";
import { state, subscribe } from "./state";

type RenewalRow = components["schemas"]["RenewalRow"];
const CREATED_AT = "2026-10-20T14:00:00Z";
const FIXTURE_OWNER: Readonly<Record<string, string>> = { [SAM_ID]: "m-sam", [JORDAN_ID]: "m-jordan" };

// ---- Items ----

const CATEGORY: Readonly<Record<string, Item["category"]>> = {
  "b-car": "transport",
  "b-phone": "utilities",
  "b-rent": "housing",
  "b-daycare": "childcare",
  "b-power": "utilities",
  "b-carins": "transport",
  "b-internet": "utilities",
  "b-card": "debt",
  "b-water": "utilities",
};

const NOTES: Readonly<Record<string, string>> = {
  "inc-jordan":
    "Counted in the plan on the expected date. If a paycheck is late, the plan updates when you mark it.",
  "inc-sam":
    "This is the household’s primary income, so safe to spend runs until this payday. Change it in Members & privacy.",
  "b-car": "Same amount every month.",
  "b-rent": "Same amount for the last 12 months.",
  "b-power": "When the October statement email arrives, the actual amount replaces the estimate.",
  "b-carins":
    "Also listed in Subscriptions & renewals. It lands before Sam’s payday, so it sets the lowest balance this period.",
  "b-stream": "Price-change email on Sep 28.",
  "b-card": "Uses the latest statement balance until the November statement email arrives.",
  "b-music2": "Sam marked this as possibly unused. Review it together in Tasks.",
};

function sourceOf(sources: readonly string[] | undefined): Item["source"] {
  if (sources?.includes("email")) return "email";
  if (sources?.includes("csv")) return "csv";
  if (sources?.includes("bank")) return "bank";
  return "manual";
}

function ownerFields(key: string): Pick<Item, "ownerType" | "ownerUserId"> {
  const o = owner(key);
  return o === "both" || o === "split"
    ? { ownerType: o, ownerUserId: null }
    : { ownerType: "member", ownerUserId: o };
}

function toItem(i: ItemInput): Item {
  const est = estimate(i);
  const previous = i.previousAmountCents ?? null;
  return {
    id: i.id,
    householdId: HOUSEHOLD_ID,
    direction: i.direction,
    kind: i.kind,
    category: i.direction === "inflow" ? "income" : (CATEGORY[i.id] ?? "subscription"),
    name: i.name,
    providerName: null,
    providerDomain: null,
    amountType: i.amount.type === "fixed" ? "fixed" : i.amount.type,
    amountCents: est.amountCents,
    schedule: i.schedule,
    weekendRule: i.weekendRule ?? "none",
    ...ownerFields(i.owner),
    status: i.status ?? "active",
    source: sourceOf(i.sources),
    accountLast4: null,
    paidFrom: i.paidFrom ?? "account",
    markedPossiblyUnused: i.markedPossiblyUnused ?? false,
    subcategory: i.subcategory ?? null,
    movable: i.movable ?? null,
    onBillsPage: i.onBillsPage !== false,
    notes: NOTES[i.id] ?? null,
    renewal:
      previous !== null
        ? {
            autoRenews: "yes",
            coverageStart: null,
            coverageEnd: null,
            cancelBy: null,
            decisionBy: null,
            shopAroundOn: null,
            previousAmountCents: previous,
            priceChangedOn: i.priceChangedOn ?? null,
          }
        : null,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

/** `GET /items` (+ `include=averages`), sorted by next date is done by the screen. */
export function buildItems(scenario: Scenario): { data: Item[]; nextCursor: null; averages: BillsAverages } {
  const engineInput = input(scenario);
  return {
    data: engineInput.items.map(toItem),
    nextCursor: null,
    averages: billsAverages(engineInput),
  };
}

/** `GET /items/:id/history`: the last three bills, oldest first. */
export function buildHistory(scenario: Scenario, itemId: string) {
  const engineInput = input(scenario);
  const item = engineInput.items.find((i) => i.id === itemId);
  if (!item) return null;
  const asOf = parseDate(engineInput.asOf);
  const dates = expandSchedule(item.schedule, asOf.subtract({ days: 400 }), asOf.subtract({ days: 1 }))
    .slice(-3)
    .map((d) => d.toString());
  const source = sourceOf(item.sources) === "manual" ? "manual" : sourceOf(item.sources);
  const est = estimate(item);
  const amounts =
    est.basis === "history"
      ? est.historyCents.slice(-dates.length)
      : est.basis === "statement"
        ? []
        : dates.map((d) =>
            item.previousAmountCents != null && item.priceChangedOn != null && d < item.priceChangedOn
              ? item.previousAmountCents
              : est.amountCents,
          );
  const offset = dates.length - amounts.length;
  return {
    data: amounts.map((amountCents, n) => ({
      id: `${itemId}:${dates[n + offset]}`,
      occurredOn: dates[n + offset] ?? "",
      amountCents,
      source,
    })),
  };
}

/** `GET /occurrences?from=&to=`: scheduled occurrences of active items. */
export function buildOccurrences(scenario: Scenario, from: string, to: string) {
  const engineInput = input(scenario);
  const data = engineInput.items
    .filter((i) => (i.status ?? "active") === "active")
    .flatMap((i) =>
      expandSchedule(i.schedule, parseDate(from), parseDate(to)).map((d) => ({
        id: `${i.id}:${d.toString()}`,
        householdId: HOUSEHOLD_ID,
        itemId: i.id,
        scheduledOn: d.toString(),
        dueOn: d.toString(),
        actualAmountCents: null,
        status: (store.settled.get(`${i.id}:${d.toString()}`) ?? "scheduled") as
          "scheduled" | "paid" | "received",
        paidOn: store.settled.has(`${i.id}:${d.toString()}`) ? engineInput.asOf : null,
        markedBy: null,
        movedBy: null,
        version: 1,
      })),
    )
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.itemId.localeCompare(b.itemId));
  return { data };
}

/** `PATCH /occurrences/:id`: mark paid or received, or undo. */
export function patchOccurrence(
  id: string,
  status: "paid" | "received" | "scheduled",
): { id: string; status: string } {
  if (status === "scheduled") store.settled.delete(id);
  else store.settled.set(id, status);
  const [itemId = "", date = ""] = id.split(":");
  return {
    id,
    householdId: HOUSEHOLD_ID,
    itemId,
    scheduledOn: date,
    dueOn: date,
    actualAmountCents: null,
    status,
    paidOn: status === "scheduled" ? null : input(state.scenario).asOf,
    markedBy: status === "scheduled" ? null : SAM_ID,
    movedBy: null,
    version: 1,
  } as { id: string; status: string };
}

// ---- Renewals ----

function renewalRow(r: ReturnType<typeof renewalsSummary>["rows"][number]): RenewalRow {
  const { reminderOffsetsDays, ...rest } = r;
  return { ...rest, owner: owner(r.owner), reminderOffsetsDays };
}

export function buildRenewals(scenario: Scenario, category?: string): { data: RenewalRow[] } {
  const rows = renewalsSummary(input(scenario)).rows.map(renewalRow);
  return { data: category ? rows.filter((r) => r.category === category) : rows };
}

export function buildRenewalsSummary(scenario: Scenario): RenewalsSummary {
  const { rows: _rows, ...summary } = renewalsSummary(input(scenario));
  return summary;
}

// ---- Tasks (mutable) ----

interface TaskMeta {
  linkedItemId: string | null;
  linkedItemName: string | null;
  source: Task["source"];
  createdBy: string | null;
  auto?: boolean;
}

const TASK_META: Readonly<Record<string, TaskMeta>> = {
  t1: {
    linkedItemId: "b-stream",
    linkedItemName: "Streaming bundle, Music (second service)",
    source: "engine",
    createdBy: null,
  },
  t2: {
    linkedItemId: "b-power",
    linkedItemName: "Electricity",
    source: "engine",
    createdBy: null,
    auto: true,
  },
  t3: { linkedItemId: "b-carins", linkedItemName: "Car insurance", source: "user", createdBy: SAM_ID },
  t4: { linkedItemId: "r-health", linkedItemName: "Health insurance", source: "email", createdBy: null },
  t5: { linkedItemId: "r-av", linkedItemName: "Antivirus", source: "email", createdBy: null },
  t6: { linkedItemId: "r-renters", linkedItemName: "Renters insurance", source: "renewal", createdBy: null },
  t7: { linkedItemId: "r-reg", linkedItemName: "Car registration", source: "renewal", createdBy: null },
  d1: { linkedItemId: null, linkedItemName: null, source: "user", createdBy: SAM_ID },
  d2: { linkedItemId: null, linkedItemName: null, source: "setup", createdBy: null },
  d3: { linkedItemId: null, linkedItemName: null, source: "setup", createdBy: null },
};

function seedTasks(): Task[] {
  return riveraFixture.tasks.map((t) => {
    const key = owner(t.owner);
    const meta = TASK_META[t.id];
    const shared = key === "both" || key === "split";
    return {
      id: t.id,
      householdId: HOUSEHOLD_ID,
      title: t.title,
      ownerType: shared ? key : "member",
      ownerUserId: shared ? null : key,
      dueOn: t.dueOn,
      dueHint: t.dueHint ?? null,
      linkedItemId: meta?.linkedItemId ?? null,
      linkedItemName: meta?.linkedItemName ?? null,
      source: meta?.source ?? "user",
      autoCompleteRule:
        meta?.auto && meta.linkedItemId
          ? { type: "actual_amount_received", itemId: meta.linkedItemId }
          : null,
      completed: t.completed,
      completedAt: t.completed ? `${t.dueOn}T14:00:00Z` : null,
      completedBy: t.completed ? SAM_ID : null,
      completedReason: null,
      version: 1,
      createdBy: meta?.createdBy ?? null,
      createdAt: CREATED_AT,
    } as Task;
  });
}

interface Store {
  tasks: Task[];
  proposals: Proposal[];
  /** Goals created in this session (applied). */
  newGoals: GoalInput[];
  /** Occurrence ids the household marked paid or received. */
  settled: Map<string, "paid" | "received">;
  nextId: number;
}

function fresh(): Store {
  return {
    tasks: state.scenario === "empty" ? [] : seedTasks(),
    proposals: [],
    newGoals: [],
    settled: new Map(),
    nextId: 1,
  };
}

let store = fresh();
// Changing the scenario (or the test harness resetting the mock) starts a new household.
subscribe(() => {
  store = fresh();
});

const toTaskInput = (t: Task): TaskInput => ({
  id: t.id,
  title: t.title,
  owner: t.ownerUserId ? (FIXTURE_OWNER[t.ownerUserId] ?? t.ownerUserId) : t.ownerType,
  dueOn: t.dueOn,
  completed: t.completed,
});

export function buildTasks(scenario: Scenario, ownerQuery?: string) {
  const asOf = input(scenario).asOf;
  const filter = ownerQuery ? (FIXTURE_OWNER[ownerQuery] ?? ownerQuery) : null;
  const groups = tasksDueThisWeek(store.tasks.map(toTaskInput), asOf, { owner: filter });
  const byId = new Map(store.tasks.map((t) => [t.id, t]));
  const pick = (list: TaskInput[]): Task[] => list.flatMap((t) => byId.get(t.id) ?? []);
  return {
    dueThisWeek: pick(groups.dueThisWeek),
    later: pick(groups.later),
    done: pick(groups.done),
    navBadge: groups.navBadge,
  };
}

/** The Tasks nav badge: open tasks due within 7 days, whatever the owner (rule 15). */
export function taskBadge(scenario: Scenario): number {
  return buildTasks(scenario).navBadge;
}

export function patchTask(
  id: string,
  version: number,
  body: { completed?: boolean },
): Task | "conflict" | null {
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;
  if (task.version !== version) return "conflict";
  if (body.completed !== undefined) {
    task.completed = body.completed;
    task.completedAt = body.completed ? `${input(state.scenario).asOf}T14:00:00Z` : null;
    task.completedBy = body.completed ? SAM_ID : null;
  }
  task.version += 1;
  return { ...task };
}

export function createTask(body: {
  title: string;
  ownerType: Task["ownerType"];
  ownerUserId?: string | null;
  dueOn?: string | null;
  dueHint?: string | null;
}): Task {
  const task: Task = {
    id: `t-new-${store.nextId++}`,
    householdId: HOUSEHOLD_ID,
    title: body.title,
    ownerType: body.ownerType,
    ownerUserId: body.ownerUserId ?? null,
    dueOn: body.dueOn ?? null,
    dueHint: body.dueHint ?? null,
    linkedItemId: null,
    linkedItemName: null,
    source: "user",
    autoCompleteRule: null,
    completed: false,
    completedAt: null,
    completedBy: null,
    completedReason: null,
    version: 1,
    createdBy: SAM_ID,
    createdAt: CREATED_AT,
  };
  store.tasks.push(task);
  return { ...task };
}

// ---- Goals ----

function goalsInput(scenario: Scenario): EngineInput {
  const base = input(scenario);
  return { ...base, goals: [...base.goals, ...store.newGoals] };
}

export function buildGoals(scenario: Scenario) {
  const engineInput = goalsInput(scenario);
  const summary = goalsSummary(engineInput);
  const goals: Goal[] = goalRows(engineInput);
  const nextMonth = engineInput.asOf;
  return {
    savingEachMonthCents: summary.savingEachMonthCents,
    savedSoFarCents: summary.savedSoFarCents,
    effectOnSafeToSpendCents: summary.effectOnSafeToSpendCents,
    nextTransferOn: goals.length > 0 ? firstPayday(engineInput, nextMonth) : null,
    data: goals,
  };
}

/** The next primary payday: Nov 6 in the fixture (the first goal deposit date, rule 16). */
function firstPayday(engineInput: EngineInput, asOf: string): string | null {
  const primary = engineInput.items.find((i) => i.id === engineInput.primaryIncomeItemId);
  if (!primary) return null;
  const start = parseDate(asOf);
  return expandSchedule(primary.schedule, start, start.add({ days: 62 }))[0]?.toString() ?? null;
}

export function findGoal(scenario: Scenario, id: string): Goal | undefined {
  return goalRows(goalsInput(scenario)).find((g) => g.id === id);
}

export function buildGoalOptions(scenario: Scenario, id: string): GoalOptions | null {
  const engineInput = goalsInput(scenario);
  const goal = engineInput.goals.find((g) => g.id === id);
  if (!goal) return null;
  const s = goalStatus(engineInput, goal);
  const options: GoalOptions["options"] = [];
  if (s.status === "behind" || s.status === "to_set_aside") {
    if (s.suggestedMonthlyCents != null)
      options.push({ kind: "raise_monthly", monthlyCents: s.suggestedMonthlyCents });
    if (s.alternativeTargetDate) options.push({ kind: "move_date", targetDate: s.alternativeTargetDate });
    if (s.projectedByTargetCents != null)
      options.push({ kind: "lower_target", targetCents: s.projectedByTargetCents });
  }
  return { goalId: id, status: s.status, options };
}

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}

const dollars = (cents: number) => money(cents, { mode: "headline", rounding: "nearest" });

/** The engine's goal status at a monthly amount nobody has saved yet (Q-160). */
export function buildGoalPreview(scenario: Scenario, id: string, monthlyCents: number): GoalPreview | null {
  const engineInput = goalsInput(scenario);
  const goal = engineInput.goals.find((g) => g.id === id);
  if (!goal) return null;
  const draft: EngineInput = {
    ...engineInput,
    goals: engineInput.goals.map((g) => (g.id === id ? { ...g, monthlyCents } : g)),
  };
  const s = goalStatus(draft, { ...goal, monthlyCents });
  const saving = goalsSummary(draft).savingEachMonthCents;
  const k = s.contributionsByTarget;
  let math: GoalPreview["math"];
  let result: GoalPreview["result"];
  if (s.targetDate && k !== null && s.projectedByTargetCents !== null) {
    math = [
      { label: "Saved so far", cents: s.savedCents, kind: "value" },
      {
        label: `${k} paydays × ${dollars(monthlyCents)}`,
        cents: s.projectedByTargetCents - s.savedCents,
        kind: "value",
      },
      { label: "By target date", cents: s.projectedByTargetCents, kind: "total" },
    ];
    result =
      s.gapCents && s.gapCents > 0
        ? { text: `−${dollars(s.gapCents)}`, onTrack: false }
        : { text: "On track", onTrack: true };
  } else {
    math = [
      { label: "Saved so far", cents: s.savedCents, kind: "value" },
      { label: "Each month", cents: monthlyCents, kind: "value" },
      { label: "Remaining", cents: s.remainingCents, kind: "total" },
    ];
    result =
      s.status === "reached"
        ? { text: "Reached", onTrack: true }
        : s.reachMonth
          ? { text: `Reached ${monthLabel(s.reachMonth)}`, onTrack: true }
          : { text: "Not scheduled", onTrack: false };
  }
  const {
    goalId: _goalId,
    name: _name,
    type: _type,
    savedCents: _saved,
    targetCents: _target,
    monthlyCents: _m,
    targetDate: _date,
    ...progress
  } = s;
  return {
    goalId: id,
    monthlyCents,
    progress: {
      status: progress.status,
      percent: progress.percent,
      remainingCents: progress.remainingCents,
      reachMonth: progress.reachMonth,
      contributionsByTarget: progress.contributionsByTarget,
      projectedByTargetCents: progress.projectedByTargetCents,
      gapCents: progress.gapCents,
      suggestedMonthlyCents: progress.suggestedMonthlyCents,
      alternativeTargetDate: progress.alternativeTargetDate,
    },
    math,
    result,
    savingEachMonthCents: saving,
  };
}

function proposalFor(goal: Goal, toMonthlyCents: number, scenario: Scenario): Proposal {
  const engineInput = goalsInput(scenario);
  const diff = whatIf(engineInput, [
    { type: "set_goal_monthly", goalId: goal.id, monthlyCents: toMonthlyCents },
  ]).diff;
  const proposal: Proposal = {
    id: `pr-${store.nextId++}`,
    householdId: HOUSEHOLD_ID,
    kind: "goal_change",
    payload: {
      type: "goal_monthly",
      goalId: goal.id,
      goalName: goal.name,
      fromMonthlyCents: goal.monthlyCents,
      toMonthlyCents,
      effect: {
        safeToSpendBeforeCents: diff.safeToSpendBeforeCents,
        safeToSpendAfterCents: diff.safeToSpendAfterCents,
      },
    },
    calcSnapshotId: null,
    proposedBy: SAM_ID,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: "2026-11-10T14:00:00Z",
    createdAt: `${engineInput.asOf}T14:00:00Z`,
  };
  store.proposals = store.proposals.filter(
    (p) => !(p.payload.type === "goal_monthly" && p.payload.goalId === goal.id),
  );
  store.proposals.push(proposal);
  return proposal;
}

/** `PATCH /goals/:id`: a new monthly amount becomes a proposal for the other member (202). */
export function patchGoal(
  scenario: Scenario,
  id: string,
  version: number,
  body: { monthlyCents?: number },
): { status: 200; goal: Goal } | { status: 202; proposal: Proposal } | { status: 404 } | { status: 409 } {
  const goal = findGoal(scenario, id);
  if (!goal) return { status: 404 };
  if (goal.version !== version) return { status: 409 };
  if (body.monthlyCents !== undefined && body.monthlyCents !== goal.monthlyCents) {
    return { status: 202, proposal: proposalFor(goal, body.monthlyCents, scenario) };
  }
  return { status: 200, goal };
}

export function createGoal(
  scenario: Scenario,
  body: {
    name: string;
    type: "savings" | "planned_expense";
    targetCents: number;
    monthlyCents?: number;
    savedCents?: number;
    targetDate?: string | null;
    isEmergencyFund?: boolean;
  },
): { status: 201; goal: Goal } | { status: 202; goal: Goal; proposal: Proposal } {
  const requested = body.monthlyCents ?? 0;
  const id = `g-new-${store.nextId++}`;
  store.newGoals.push({
    id,
    name: body.name,
    type: body.type,
    targetCents: body.targetCents,
    savedCents: body.savedCents ?? 0,
    monthlyCents: 0,
    targetDate: body.targetDate ?? null,
    emergencyFund: body.isEmergencyFund ?? false,
  });
  const goal = findGoal(scenario, id) as Goal;
  if (requested > 0) return { status: 202, goal, proposal: proposalFor(goal, requested, scenario) };
  return { status: 201, goal };
}

export function listProposals(status?: string): { data: Proposal[] } {
  return { data: store.proposals.filter((p) => !status || p.status === status) };
}

// ---- Planned expenses ----

export function buildPlannedExpenses(scenario: Scenario): { data: PlannedExpense[] } {
  const data = input(scenario).plannedExpenses.map((p): PlannedExpense => ({
    id: p.id,
    householdId: HOUSEHOLD_ID,
    name: p.name,
    amountCents: p.amountCents,
    dueOn: p.dueOn,
    ...ownerFields(p.owner),
    goalId: p.goalId ?? null,
    status: p.status ?? "planned",
    version: 1,
    createdAt: CREATED_AT,
  }));
  return { data };
}
