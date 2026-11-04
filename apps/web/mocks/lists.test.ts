// The list mocks are shaped exactly as their contracts (parsed with the @mp/contracts schemas) and carry the
// fixture's golden values (billsPage, renewals, goalsPage, tasks).
import {
  AmountHistory,
  BillsAverages,
  GoalList,
  GoalOptions,
  Item,
  OccurrenceList,
  PlannedExpenseList,
  Proposal,
  RenewalList,
  RenewalsSummary,
  TaskGroups,
} from "@mp/contracts";
import { riveraFixture } from "@mp/engine/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGoalOptions,
  buildGoalPreview,
  buildGoals,
  buildHistory,
  buildItems,
  buildOccurrences,
  buildPlannedExpenses,
  buildRenewals,
  buildRenewalsSummary,
  buildTasks,
  patchGoal,
  patchTask,
} from "./lists-model";
import { SAM_ID } from "./identity";
import { setScenario } from "./state";

const expected = riveraFixture.expected;

/** The mock uses the fixture's ids ("b-power") so they match the plan mock; contracts want UUIDs. */
function uuidFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-8000-${h.toString(16).padStart(12, "0")}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

function asUuids(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => asUuids(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asUuids(v, k)]));
  if (typeof value === "string" && !UUID.test(value) && /(^id$|Id$|^ids$)/.test(key)) return uuidFor(value);
  return value;
}

beforeEach(() => setScenario("base"));

describe("items and bills averages", () => {
  it("parses as the Item and BillsAverages contracts", () => {
    const page = buildItems("base");
    for (const item of page.data) Item.parse(asUuids(item));
    BillsAverages.parse(asUuids(page.averages));
    OccurrenceList.parse(asUuids(buildOccurrences("base", "2026-10-27", "2026-11-30")));
    AmountHistory.parse(asUuids(buildHistory("base", "b-power")));
  });

  it("carries the billsPage golden values", () => {
    const { data, averages } = buildItems("base");
    const g = expected.billsPage;
    expect(data).toHaveLength(g.rows);
    expect(averages.rows).toBe(g.rows);
    expect(averages.monthlyBillsAverageCents).toBe(g.monthlyBillsAverageCents);
    expect(averages.monthlyIncomeAverageCents).toBe(g.monthlyIncomeAverageCents);
    expect(averages.leftAfterBillsCents).toBe(g.leftAfterBillsCents);
    expect(averages.estimatesToConfirm).toBe(g.estimatesToConfirm);
  });

  it("gives electricity its estimate and history Aug $118, Sep $171, Oct $137", () => {
    const power = buildItems("base").data.find((i) => i.id === "b-power");
    expect(power?.amountType).toBe("estimated");
    expect(power?.amountCents).toBe(14200);
    expect(buildHistory("base", "b-power")?.data.map((h) => [h.occurredOn, h.amountCents])).toEqual([
      ["2026-08-03", 11800],
      ["2026-09-03", 17100],
      ["2026-10-03", 13700],
    ]);
  });
});

describe("renewals", () => {
  it("parses as the RenewalList and RenewalsSummary contracts", () => {
    RenewalList.parse(asUuids(buildRenewals("base")));
    RenewalsSummary.parse(asUuids(buildRenewalsSummary("base")));
  });

  it("carries the renewals golden values", () => {
    const g = expected.renewals;
    const s = buildRenewalsSummary("base");
    expect(s.count).toBe(g.count);
    expect(s.yearlyCents).toBe(g.yearlyCents);
    expect(s.next90Days.cents).toBe(g.bigRenewalsNext90DaysCents);
    expect(s.priceIncreaseYearlyCents).toBe(g.priceIncreaseYearlyCents);
    expect(s.couldSaveYearlyCents).toBe(g.couldSaveYearlyCents);
    expect(buildRenewals("base").data).toHaveLength(g.count);
  });
});

describe("goals", () => {
  it("parses as the GoalList, GoalOptions, PlannedExpenseList contracts", () => {
    GoalList.parse(asUuids(buildGoals("base")));
    GoalOptions.parse(asUuids(buildGoalOptions("base", "g-tahoe")));
    PlannedExpenseList.parse(asUuids(buildPlannedExpenses("base")));
  });

  it("carries the goalsPage golden values", () => {
    const g = expected.goalsPage;
    const list = buildGoals("base");
    expect(list.savingEachMonthCents).toBe(g.savingEachMonthCents);
    expect(list.savedSoFarCents).toBe(g.savedSoFarCents);
    expect(list.effectOnSafeToSpendCents).toBe(g.effectOnSafeToSpendCents);
    expect(list.nextTransferOn).toBe("2026-11-06");
    const byId = new Map(list.data.map((x) => [x.id, x]));
    expect(byId.get("g-emergency")?.progress.percent).toBe(g.emergency.percent);
    expect(byId.get("g-emergency")?.progress.reachMonth).toBe("2027-10");
    expect(byId.get("g-tahoe")?.progress.percent).toBe(g.tahoe.percent);
    expect(byId.get("g-tahoe")?.progress.gapCents).toBe(25000);
    expect(byId.get("g-tahoe")?.progress.suggestedMonthlyCents).toBe(g.tahoe.suggestedMonthlyCents);
    expect(byId.get("g-gifts")?.progress.percent).toBe(g.gifts.percent);
    expect(byId.get("g-gifts")?.progress.gapCents).toBe(38000);
    expect(byId.get("g-gifts")?.progress.suggestedMonthlyCents).toBe(g.gifts.suggestedMonthlyCents);
  });

  it("previews a monthly amount through the engine", () => {
    const p = buildGoalPreview("base", "g-tahoe", 31300);
    expect(p?.result).toEqual({ text: "On track", onTrack: true });
    expect(p?.savingEachMonthCents).toBe(30000 + 31300);
    expect(buildGoalPreview("base", "g-tahoe", 25000)?.result.text).toBe("−$250");
  });

  it("answers a monthly change with a pending proposal and leaves the goal alone", () => {
    const goal = buildGoals("base").data.find((x) => x.id === "g-tahoe");
    const result = patchGoal("base", "g-tahoe", goal?.version ?? 1, { monthlyCents: 31300 });
    expect(result.status).toBe(202);
    if (result.status === 202) {
      Proposal.parse(asUuids(result.proposal));
      expect(result.proposal.status).toBe("pending");
    }
    expect(buildGoals("base").data.find((x) => x.id === "g-tahoe")?.monthlyCents).toBe(25000);
  });
});

describe("tasks", () => {
  it("parses as TaskGroups and carries the tasks golden values", () => {
    const groups = buildTasks("base");
    TaskGroups.parse(asUuids(groups));
    const g = expected.tasks;
    expect(groups.dueThisWeek).toHaveLength(g.dueThisWeek);
    expect(groups.later).toHaveLength(g.later);
    expect(groups.done).toHaveLength(g.done);
    expect(groups.navBadge).toBe(g.navBadge);
  });

  it("saves a completion and moves the task to Done; a stale version conflicts", () => {
    const task = patchTask("t1", 1, { completed: true });
    expect(task).toMatchObject({ completed: true, version: 2 });
    expect(buildTasks("base").done).toHaveLength(4);
    expect(buildTasks("base").navBadge).toBe(2);
    expect(patchTask("t1", 1, { completed: false })).toBe("conflict");
  });

  it("filters by owner, including Both", () => {
    const sam = buildTasks("base", SAM_ID);
    expect(sam.dueThisWeek.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});
