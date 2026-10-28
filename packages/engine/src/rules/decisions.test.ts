import { computePlan } from "../plan";
import { riveraInput } from "../testing";
import type { EngineInput, Flag, GoalInput, ItemInput } from "../types";
import { decisions } from "./decisions";
import { ruleFlags } from "./flags";
import { computeFullPlan } from "./full-plan";

function decide(input: EngineInput) {
  return decisions(input, computePlan(input), ruleFlags(input));
}

describe("Decide this week (Overview)", () => {
  it("ranks the canvas cards: car insurance, electricity estimate, Tahoe goal", () => {
    expect(computeFullPlan(riveraInput()).decisions).toEqual([
      {
        id: "not_usual_month:b-carins:2026-11-04",
        kind: "not_usual_month",
        rank: 1,
        subjectId: "b-carins",
        owner: "m-jordan",
        date: "2026-11-04",
        templateText: "{name}, {amountCents} on {dueOn}",
        detailTemplateText:
          "This bill comes every {everyMonths} months, so it isn’t in your usual month. Paying on {altDate} instead changes safe to spend to {altSafeToSpendCents}. Only if your provider allows it.",
        params: {
          name: "Car insurance renewal",
          amountCents: 68400,
          dueOn: "2026-11-04",
          everyMonths: 6,
          altDate: "2026-11-06",
          altSafeToSpendCents: 169101,
        },
      },
      {
        id: "estimate:b-power:2026-11-03",
        kind: "estimate",
        rank: 2,
        subjectId: "b-power",
        owner: "m-sam",
        date: "2026-11-03",
        templateText: "{name} is about {amountCents} (±{rangeCents})",
        detailTemplateText:
          "Based on your last {historyCount} bills ({minCents}–{maxCents}). Confirm the amount when it arrives and the plan updates.",
        params: {
          name: "Electricity",
          amountCents: 14200,
          dueOn: "2026-11-03",
          rangeCents: 3000,
          minCents: 11800,
          maxCents: 17100,
          historyCount: 3,
        },
      },
      {
        id: "goal_behind:g-tahoe:2027-03-01",
        kind: "goal_behind",
        rank: 3,
        subjectId: "g-tahoe",
        owner: "both",
        date: "2027-03-01",
        templateText: "{name} is {behindCents} behind",
        detailTemplateText:
          "At {monthlyCents} a month you’ll have {projectedCents} by {targetDate}. Raising it to {suggestedMonthlyCents} or moving the date to {alternativeTargetDate} closes the gap.",
        params: {
          name: "Lake Tahoe trip",
          behindCents: 25000,
          monthlyCents: 25000,
          projectedCents: 215000,
          targetDate: "2027-03-01",
          suggestedMonthlyCents: 31300,
          alternativeTargetDate: "2027-04-01",
        },
      },
    ]);
  });

  it("puts the shortfall first in the shortfall scenario", () => {
    const d = computeFullPlan(riveraInput({ scenario: "shortfall" })).decisions;
    expect(d.map((x) => x.id)).toEqual([
      "shortfall:household:2026-11-05",
      "not_usual_month:b-carins:2026-11-04",
      "estimate:b-power:2026-11-03",
      "goal_behind:g-tahoe:2027-03-01",
    ]);
    expect(d[0]?.params).toEqual({
      shortfallCents: 79300,
      safeToSpendCents: -79299,
      paydayOn: "2026-11-06",
      belowCushionOn: "2026-11-03",
      belowZeroOn: "2026-11-04",
      lowestCents: -29299,
      lowestOn: "2026-11-05",
    });
    expect(d[1]?.params.altSafeToSpendCents).toBe(-10899);
  });

  it("names no first day below $0 when the balance stays above it", () => {
    const input = riveraInput();
    input.cushionCents = 200000;
    const d = decide(input);
    expect(d[0]?.kind).toBe("shortfall");
    expect(d[0]?.params.belowZeroOn).toBeNull();
  });

  it("offers no alternative date when moving to payday does not change safe to spend", () => {
    // Electricity on payday itself has no "pay on payday" alternative; car insurance due on payday neither.
    const input = riveraInput({
      occurrences: [{ itemId: "b-carins", scheduledOn: "2026-11-04", dueOn: "2026-11-06" }],
    });
    const d = decide(input).find((x) => x.kind === "not_usual_month");
    expect(d?.params.altDate).toBeNull();
    expect(d?.params.altSafeToSpendCents).toBeNull();
    expect(d?.detailTemplateText).toBe(
      "This bill comes every {everyMonths} months, so it isn’t in your usual month.",
    );
  });

  it("drops the alternative when moving the bill to payday changes nothing (rule 9)", () => {
    const input = riveraInput();
    // A $0 yearly fee in the window: moving it never changes safe to spend.
    const yearly: ItemInput = {
      id: "b-yearly",
      name: "Yearly fee",
      direction: "outflow",
      kind: "membership",
      owner: "m-sam",
      amount: { type: "fixed", cents: 0 },
      schedule: { type: "yearly", dtstart: "2026-11-02" },
    };
    input.items.push(yearly);
    const d = decide(input).find((x) => x.subjectId === "b-yearly");
    expect(d?.params).toMatchObject({ everyMonths: 12, altDate: null });
  });

  it("skips a not-in-usual-month flag whose occurrence is already paid", () => {
    const input = riveraInput({
      occurrences: [{ itemId: "b-carins", scheduledOn: "2026-11-04", status: "paid", paidOn: "2026-10-28" }],
    });
    expect(decide(input).map((x) => x.kind)).not.toContain("not_usual_month");
  });

  it("uses the statement template for a credit card estimate in the window", () => {
    const input = riveraInput({
      occurrences: [{ itemId: "b-card", scheduledOn: "2026-11-15", dueOn: "2026-11-02" }],
    });
    const d = decide(input).find((x) => x.subjectId === "b-card");
    expect(d?.templateText).toBe("{name} is about {amountCents}");
    expect(d?.detailTemplateText).toBe(
      "Based on the last statement balance. Enter the statement balance when it posts.",
    );
    expect(d?.params).toMatchObject({ amountCents: 64000, rangeCents: null, historyCount: 0 });
  });

  it("includes deadlines within 7 days only", () => {
    const input = {
      ...riveraInput(),
      asOf: "2026-11-06",
      startingBalance: { cents: 340000, asOf: "2026-11-06" },
    };
    const d = decide(input).filter((x) => x.kind === "decide_by");
    expect(d).toEqual([
      {
        id: "decide_by:r-health:2026-11-13",
        kind: "decide_by",
        rank: expect.any(Number),
        subjectId: "r-health",
        owner: "m-jordan",
        date: "2026-11-13",
        templateText: "Decide on {name} by {deadlineOn}",
        detailTemplateText: "It renews on {renewsOn}.",
        params: {
          name: "Health insurance",
          deadlineOn: "2026-11-13",
          deadlineKind: "decision",
          renewsOn: "2027-01-01",
        },
      },
    ]);
  });

  it("words a cancel-by deadline as a question", () => {
    const input = {
      ...riveraInput(),
      asOf: "2026-11-25",
      startingBalance: { cents: 340000, asOf: "2026-11-25" },
    };
    const d = decide(input).find((x) => x.subjectId === "r-av");
    expect(d).toMatchObject({
      templateText: "Cancel {name} by {deadlineOn}?",
      params: { deadlineOn: "2026-11-30", deadlineKind: "cancel" },
    });
  });

  it("treats a decide-by flag with no deadline kind as a decision", () => {
    const input = riveraInput();
    const flag: Flag = { code: "decide_by", subjectId: "r-health", date: "2026-10-28" };
    const d = decisions(input, computePlan(input), [flag]).find((x) => x.kind === "decide_by");
    expect(d?.params.deadlineKind).toBe("decision");
  });

  it("ignores a decide-by flag with no matching renewal", () => {
    const input = riveraInput();
    const extra: Flag = { code: "decide_by", subjectId: "nope", date: "2026-10-28" };
    expect(decisions(input, computePlan(input), [extra]).map((x) => x.kind)).not.toContain("decide_by");
  });

  it("words the goal card by the options available", () => {
    const input = riveraInput();
    const goals: GoalInput[] = [
      // Behind with no deposits before the date: no suggestion; a monthly amount gives a new date.
      {
        id: "g-a",
        name: "A",
        targetCents: 100000,
        savedCents: 0,
        monthlyCents: 10000,
        targetDate: "2026-11-01",
      },
      // Behind with no monthly amount: a suggestion, no new date.
      {
        id: "g-b",
        name: "B",
        targetCents: 100000,
        savedCents: 0,
        monthlyCents: null,
        targetDate: "2027-03-01",
      },
      // Neither.
      {
        id: "g-c",
        name: "C",
        targetCents: 100000,
        savedCents: 0,
        monthlyCents: null,
        targetDate: "2026-11-01",
      },
    ];
    input.goals = goals;
    const text = Object.fromEntries(
      decide(input)
        .filter((x) => x.kind === "goal_behind")
        .map((x) => [x.subjectId, x.detailTemplateText]),
    );
    const lead = "At {monthlyCents} a month you’ll have {projectedCents} by {targetDate}.";
    expect(text).toEqual({
      "g-a": `${lead} Moving the date to {alternativeTargetDate} closes the gap.`,
      "g-b": `${lead} Raising it to {suggestedMonthlyCents} closes the gap.`,
      "g-c": lead,
    });
  });
});
