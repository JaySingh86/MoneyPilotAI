// "Decide this week" (DESIGN_SPEC §5.1 Overview): ranked decision cards with template text. Every number in
// a card is a template parameter computed here, so AI text and the UI only describe engine results.
// Contents and ranking: QUESTIONS.md Q-017.
import { compareStrings, parseDate } from "../dates";
import type {
  Decision,
  DecisionKind,
  DecisionParam,
  EngineInput,
  Flag,
  GoalInput,
  ItemInput,
  OwnerKey,
  PlanResult,
  RunwayEvent,
} from "../types";
import { estimate } from "./estimate";
import { goalStatus } from "./goals";
import type { GoalStatus } from "./goals";
import { renewalList } from "./renewals";
import { whatIf } from "./what-if";

/** Cards come in this order, then by date, then by subject. */
export const DECISION_ORDER: readonly DecisionKind[] = [
  "shortfall",
  "not_usual_month",
  "estimate",
  "decide_by",
  "goal_behind",
];

/** A deadline within this many days of today (inclusive) is "this week" (rule 15). */
export const DECIDE_THIS_WEEK_DAYS = 7;

type Draft = Omit<Decision, "rank" | "date"> & { date: string };

function draft(
  kind: DecisionKind,
  subjectId: string | null,
  owner: OwnerKey,
  date: string,
  templateText: string,
  detailTemplateText: string,
  params: Record<string, DecisionParam>,
): Draft {
  const id = `${kind}:${subjectId ?? "household"}:${date}`;
  return { id, kind, subjectId, owner, date, templateText, detailTemplateText, params };
}

function shortfallDecision(plan: PlanResult): Draft {
  return draft(
    "shortfall",
    null,
    "both",
    plan.lowest.date,
    "Short {shortfallCents} before {paydayOn}",
    "Below your cushion from {belowCushionOn}. The lowest projected balance is {lowestCents} on {lowestOn}.",
    {
      shortfallCents: plan.shortfallDisplayCents,
      safeToSpendCents: plan.safeToSpendCents,
      paydayOn: plan.window.to,
      belowCushionOn: plan.belowCushionFrom,
      belowZeroOn: plan.belowZeroDates[0] ?? null,
      lowestCents: plan.lowest.balanceCents,
      lowestOn: plan.lowest.date,
    },
  );
}

function everyMonths(item: ItemInput): number {
  return item.schedule.type === "every_n_months" ? item.schedule.n : 12;
}

/** Not in your usual month, with rule 9's "pay on payday instead" when it changes safe to spend. */
function notUsualMonth(input: EngineInput, plan: PlanResult, event: RunwayEvent, item: ItemInput): Draft {
  const moved =
    event.dueOn < plan.window.to
      ? whatIf(
          input,
          [
            {
              type: "move_occurrence",
              itemId: item.id,
              scheduledOn: event.scheduledOn,
              toDate: plan.window.to,
            },
          ],
          plan,
        )
      : null;
  const alt = moved !== null && moved.diff.changesSafeToSpend ? moved : null;
  const base = "This bill comes every {everyMonths} months, so it isn’t in your usual month.";
  return draft(
    "not_usual_month",
    item.id,
    item.owner,
    event.dueOn,
    "{name}, {amountCents} on {dueOn}",
    alt
      ? `${base} Paying on {altDate} instead changes safe to spend to {altSafeToSpendCents}. Only if your provider allows it.`
      : base,
    {
      name: item.name,
      amountCents: -event.amountCents,
      dueOn: event.dueOn,
      everyMonths: everyMonths(item),
      altDate: alt ? plan.window.to : null,
      altSafeToSpendCents: alt ? alt.plan.safeToSpendCents : null,
    },
  );
}

function estimateDecision(event: RunwayEvent, item: ItemInput): Draft {
  const e = estimate(item);
  const history = e.basis === "history";
  return draft(
    "estimate",
    item.id,
    item.owner,
    event.dueOn,
    history ? "{name} is about {amountCents} (±{rangeCents})" : "{name} is about {amountCents}",
    history
      ? "Based on your last {historyCount} bills ({minCents}–{maxCents}). Confirm the amount when it arrives and the plan updates."
      : "Based on the last statement balance. Enter the statement balance when it posts.",
    {
      name: item.name,
      amountCents: -event.amountCents,
      dueOn: event.dueOn,
      rangeCents: e.rangeCents,
      minCents: e.minCents,
      maxCents: e.maxCents,
      historyCount: e.historyCents.length,
    },
  );
}

/** Rule 10's ways to close the gap, as one sentence (empty when there are none). */
function closeTheGap(s: GoalStatus): string {
  const ways = [
    s.suggestedMonthlyCents !== null ? "raising it to {suggestedMonthlyCents}" : null,
    s.alternativeTargetDate !== null ? "moving the date to {alternativeTargetDate}" : null,
  ]
    .filter((w): w is string => w !== null)
    .join(" or ");
  return ways === "" ? "" : ` ${ways.charAt(0).toUpperCase()}${ways.slice(1)} closes the gap.`;
}

function goalDecision(input: EngineInput, goal: GoalInput): Draft | null {
  const s = goalStatus(input, goal);
  if (s.status !== "behind") return null;
  return draft(
    "goal_behind",
    goal.id,
    "both",
    s.targetDate as string,
    "{name} is {behindCents} behind",
    `At {monthlyCents} a month you’ll have {projectedCents} by {targetDate}.${closeTheGap(s)}`,
    {
      name: goal.name,
      behindCents: s.gapCents,
      monthlyCents: s.monthlyCents,
      projectedCents: s.projectedByTargetCents,
      targetDate: s.targetDate,
      suggestedMonthlyCents: s.suggestedMonthlyCents,
      alternativeTargetDate: s.alternativeTargetDate,
    },
  );
}

function rank(drafts: Draft[]): Decision[] {
  const order = (d: Draft) => DECISION_ORDER.indexOf(d.kind);
  return [...drafts]
    .sort((a, b) => order(a) - order(b) || compareStrings(a.date, b.date) || compareStrings(a.id, b.id))
    .map((d, i) => ({ ...d, rank: i + 1 }));
}

/**
 * The ranked cards: the shortfall, infrequent bills in the window, estimates due before payday, deadlines
 * within 7 days, and savings goals that are behind.
 */
export function decisions(input: EngineInput, plan: PlanResult, flagList: readonly Flag[]): Decision[] {
  const items = new Map(input.items.map((i) => [i.id, i]));
  const scheduled = plan.runway
    .flatMap((d) => d.events)
    .filter((e) => e.kind === "bill" && e.status === "scheduled");
  const out: Draft[] = [];
  if (plan.state === "shortfall") out.push(shortfallDecision(plan));

  for (const f of flagList.filter((x) => x.code === "not_usual_month")) {
    const event = scheduled.find((e) => e.sourceId === f.subjectId && e.dueOn === f.date);
    if (event) out.push(notUsualMonth(input, plan, event, items.get(event.sourceId) as ItemInput));
  }

  for (const e of scheduled.filter((x) => x.isEstimate && x.date < plan.window.to)) {
    out.push(estimateDecision(e, items.get(e.sourceId) as ItemInput));
  }

  const weekEnd = parseDate(input.asOf).add({ days: DECIDE_THIS_WEEK_DAYS }).toString();
  const renewals = renewalList(input);
  for (const f of flagList.filter((x) => x.code === "decide_by" && (x.date as string) <= weekEnd)) {
    const r = renewals.find((x) => (x.itemId ?? x.id) === f.subjectId);
    if (!r) continue;
    const deadlineOn = f.date as string;
    const deadlineKind = f.deadlineKind ?? "decision";
    out.push(
      draft(
        "decide_by",
        f.subjectId,
        r.owner,
        deadlineOn,
        deadlineKind === "cancel" ? "Cancel {name} by {deadlineOn}?" : "Decide on {name} by {deadlineOn}",
        "It renews on {renewsOn}.",
        {
          name: r.name,
          deadlineOn,
          deadlineKind,
          renewsOn: r.renewsOn,
        },
      ),
    );
  }

  for (const g of input.goals) {
    const d = goalDecision(input, g);
    if (d) out.push(d);
  }
  return rank(out);
}
