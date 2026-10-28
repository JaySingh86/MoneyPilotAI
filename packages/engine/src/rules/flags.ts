// Rule 8 flags, plus the estimate flag (rule 6) and overdue occurrences (QUESTIONS.md Q-006).
import { compareDates, compareStrings, parseDate } from "../dates";
import type { PlainDate } from "../dates";
import { itemAmount, resolveOccurrences } from "../occurrences";
import { staleBalanceFlags } from "../plan";
import { affectsAccount } from "../runway";
import { applyWeekendRule } from "../schedule/weekend";
import type {
  EngineInput,
  Flag,
  FlagCode,
  IsoDate,
  ItemInput,
  PlanningWindow,
  RenewalInput,
  Schedule,
} from "../types";
import { validateInput } from "../validate";
import { planningWindow } from "../window";
import { priceUpShowing } from "./price";
import type { PricedThing } from "./price";
import { nextDeadline, nextRenewal, renewalList } from "./renewals";

/** Flags sort by this order, then date, then subject. */
export const FLAG_ORDER: readonly FlagCode[] = [
  "stale_balance",
  "overdue",
  "not_usual_month",
  "price_up",
  "possible_duplicate",
  "decide_by",
  "not_automatic",
  "estimate",
];

/** How far ahead the next estimated occurrence is looked for. */
const ESTIMATE_HORIZON_DAYS = 400;

/** "Every 2 months or less often" (rule 8 not in your usual month). */
export const INFREQUENT_MIN_WEEKS = 9;

export function isInfrequent(schedule: Schedule): boolean {
  switch (schedule.type) {
    case "every_n_months":
    case "yearly":
      return true;
    // 9 weeks is the first whole-week cadence beyond 2 months.
    case "every_n_weeks":
      return schedule.n >= INFREQUENT_MIN_WEEKS;
    default:
      return false;
  }
}

const isActive = (item: ItemInput) => (item.status ?? "active") === "active";

function inRange(d: PlainDate, from: PlainDate, to: PlainDate): boolean {
  return compareDates(d, from) >= 0 && compareDates(d, to) <= 0;
}

/** Not in your usual month: an infrequent bill due in the planning window. */
function notUsualMonth(input: EngineInput, from: PlainDate, to: PlainDate): Flag[] {
  return resolveOccurrences(
    input,
    from,
    to,
    (i) => i.direction === "outflow" && affectsAccount(i) && isInfrequent(i.schedule),
  )
    .filter((o) => o.status !== "skipped" && inRange(o.dueOn, from, to))
    .map((o): Flag => ({ code: "not_usual_month", subjectId: o.item.id, date: o.dueOn.toString() }));
}

/** Estimate: the next scheduled occurrence of an estimated item that has no actual amount yet. */
function estimates(input: EngineInput, asOf: PlainDate): Flag[] {
  const flagged = new Set<string>();
  const out: Flag[] = [];
  const occurrences = resolveOccurrences(
    input,
    asOf,
    asOf.add({ days: ESTIMATE_HORIZON_DAYS }),
    (i) => isActive(i) && i.direction === "outflow" && i.amount.type !== "fixed",
  );
  for (const o of occurrences) {
    if (
      flagged.has(o.item.id) ||
      o.status !== "scheduled" ||
      !o.isEstimate ||
      compareDates(o.dueOn, asOf) < 0
    )
      continue;
    flagged.add(o.item.id);
    out.push({ code: "estimate", subjectId: o.item.id, date: o.dueOn.toString() });
  }
  return out;
}

/** Overdue: a materialized occurrence still scheduled but due before the balance date, so not counted. */
function overdue(input: EngineInput): Flag[] {
  const balanceAsOf = parseDate(input.startingBalance.asOf, "startingBalance.asOf");
  const items = new Map(input.items.map((i) => [i.id, i]));
  const out: Flag[] = [];
  for (const row of input.occurrences) {
    const item = items.get(row.itemId) as ItemInput;
    if ((row.status ?? "scheduled") !== "scheduled" || !isActive(item)) continue;
    const due =
      row.dueOn != null
        ? parseDate(row.dueOn)
        : applyWeekendRule(parseDate(row.scheduledOn), item.weekendRule ?? "none");
    if (compareDates(due, balanceAsOf) < 0)
      out.push({ code: "overdue", subjectId: item.id, date: due.toString() });
  }
  return out;
}

const subjectOf = (r: RenewalInput) => r.itemId ?? r.id;

function priceUps(input: EngineInput, renewals: RenewalInput[], asOf: PlainDate): Flag[] {
  const covered = new Set(renewals.map(subjectOf));
  const priced: (PricedThing & { subjectId: string })[] = [
    ...renewals.map((r) => ({ ...r, subjectId: subjectOf(r) })),
    ...input.items
      .filter(
        (i) =>
          isActive(i) && i.direction === "outflow" && i.previousAmountCents != null && !covered.has(i.id),
      )
      .map((i) => ({ ...i, amountCents: itemAmount(i).cents, subjectId: i.id })),
  ];
  return priced
    .filter((p) => priceUpShowing(p, asOf))
    .map((p): Flag => ({ code: "price_up", subjectId: p.subjectId, date: p.priceChangedOn ?? null }));
}

/**
 * Possible duplicate: two or more active subscriptions in the same sub-category. One flag per group, on the
 * item to review first: one the household marked as possibly unused, else the cheapest, else by id.
 */
function duplicates(renewals: RenewalInput[]): Flag[] {
  const groups = new Map<string, RenewalInput[]>();
  for (const r of renewals) {
    if (r.category !== "subscription" || !r.subcategory) continue;
    groups.set(r.subcategory, [...(groups.get(r.subcategory) ?? []), r]);
  }
  const out: Flag[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [subject] = [...group].sort(
      (a, b) =>
        Number(b.markedPossiblyUnused === true) - Number(a.markedPossiblyUnused === true) ||
        a.amountCents - b.amountCents ||
        compareStrings(a.id, b.id),
    );
    out.push({
      code: "possible_duplicate",
      subjectId: subjectOf(subject as RenewalInput),
      date: null,
      relatedIds: group.map(subjectOf).sort(compareStrings),
    });
  }
  return out;
}

function renewalFlags(renewals: RenewalInput[], asOf: PlainDate): Flag[] {
  const out: Flag[] = [];
  for (const r of renewals) {
    const deadline = nextDeadline(r, asOf);
    if (deadline !== null)
      out.push({
        code: "decide_by",
        subjectId: subjectOf(r),
        date: deadline.date,
        deadlineKind: deadline.kind,
      });
    if (r.autoRenews === "no")
      out.push({ code: "not_automatic", subjectId: subjectOf(r), date: nextRenewal(r, asOf) });
  }
  return out;
}

export function sortFlags(flags: Flag[]): Flag[] {
  const order = (f: Flag) => FLAG_ORDER.indexOf(f.code);
  const date = (d: IsoDate | null) => d ?? "9999-12-31";
  return [...flags].sort(
    (a, b) =>
      order(a) - order(b) ||
      compareStrings(date(a.date), date(b.date)) ||
      compareStrings(a.subjectId ?? "", b.subjectId ?? ""),
  );
}

/**
 * Rule 8 flags (not in your usual month, price up, possible duplicate, decide by, not automatic), plus
 * estimate and overdue. `stale_balance` comes from the core plan; `flags` returns both.
 */
export function ruleFlags(input: EngineInput, window: PlanningWindow = planningWindow(input)): Flag[] {
  validateInput(input);
  const asOf = parseDate(input.asOf, "asOf");
  const renewals = renewalList(input);
  return sortFlags([
    ...overdue(input),
    ...notUsualMonth(input, parseDate(window.from), parseDate(window.to)),
    ...priceUps(input, renewals, asOf),
    ...duplicates(renewals),
    ...renewalFlags(renewals, asOf),
    ...estimates(input, asOf),
  ]);
}

/** Every flag for the household: `stale_balance` and the rule flags. */
export function flags(input: EngineInput): Flag[] {
  return sortFlags([...staleBalanceFlags(input), ...ruleFlags(input)]);
}
