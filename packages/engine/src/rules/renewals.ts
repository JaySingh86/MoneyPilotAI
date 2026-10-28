// Rule 11: subscriptions and renewals. Renewals come from `input.renewals` (renewal details) plus every
// active subscription item that has none, so the 7 monthly subscriptions appear without extra data.
import { compareDates, compareStrings, parseDate } from "../dates";
import type { PlainDate } from "../dates";
import { divRoundHalfUp, sumCents } from "../money";
import { itemAmount, resolveOccurrences } from "../occurrences";
import type {
  Cents,
  EngineInput,
  IsoDate,
  ItemInput,
  OwnerKey,
  RenewalCategory,
  RenewalInput,
  Schedule,
} from "../types";
import { priceUpShowing } from "./price";

/** "Big renewals, next 90 days" (rule 11). */
export const BIG_RENEWAL_WINDOW_DAYS = 90;
/** Billed every 6 months or less often counts as big (rule 11). */
export const BIG_RENEWAL_MIN_MONTHS = 6;
/** Shop-around date = renewal − 30 days (rule 11). */
export const SHOP_AROUND_DAYS = 30;
/** Reminder offsets for big renewals: 30 and 7 days before, and on the day (rule 11). */
export const BIG_RENEWAL_REMINDER_OFFSETS: readonly number[] = [30, 7, 0];
/** How far ahead an item's next renewal is looked for. */
const NEXT_OCCURRENCE_HORIZON_DAYS = 400;

function frequencyOf(schedule: Schedule): RenewalInput["every"] {
  switch (schedule.type) {
    case "every_n_weeks":
      return { unit: "week", n: schedule.n };
    case "every_n_months":
      return { unit: "month", n: schedule.n };
    case "yearly":
      return { unit: "month", n: 12 };
    default:
      return { unit: "month", n: 1 };
  }
}

/** The renewal row for a subscription item: its next occurrence on or after `asOf`, or null if none. */
function renewalFromItem(input: EngineInput, item: ItemInput, asOf: PlainDate): RenewalInput | null {
  const next = resolveOccurrences(
    input,
    asOf,
    asOf.add({ days: NEXT_OCCURRENCE_HORIZON_DAYS }),
    (i) => i === item,
  ).find((o) => o.status === "scheduled" && compareDates(o.dueOn, asOf) >= 0);
  if (!next) return null;
  return {
    id: item.id,
    itemId: item.id,
    name: item.name,
    category: "subscription",
    owner: item.owner,
    amountCents: itemAmount(item).cents,
    every: frequencyOf(item.schedule),
    renewsOn: next.dueOn.toString(),
    autoRenews: "yes",
    sources: [...(item.sources ?? [])],
    paidFrom: item.paidFrom ?? "account",
    previousAmountCents: item.previousAmountCents ?? null,
    priceChangedOn: item.priceChangedOn ?? null,
    priceChangeReviewed: item.priceChangeReviewed ?? false,
    markedPossiblyUnused: item.markedPossiblyUnused ?? false,
    subcategory: item.subcategory ?? null,
    decisionBy: null,
    cancelBy: null,
  };
}

/**
 * Every renewal the household has: `input.renewals`, then each active outflow subscription item that no
 * renewal points to (`itemId`). Renewal dates already passed roll forward by their frequency.
 */
export function renewalList(input: EngineInput): RenewalInput[] {
  const asOf = parseDate(input.asOf, "asOf");
  const explicit = (input.renewals ?? []).map((r) => ({ ...r, renewsOn: nextRenewal(r, asOf) }));
  const linked = new Set(explicit.map((r) => r.itemId));
  const fromItems = input.items
    .filter(
      (i) =>
        i.kind === "subscription" &&
        i.direction === "outflow" &&
        (i.status ?? "active") === "active" &&
        !linked.has(i.id),
    )
    .map((i) => renewalFromItem(input, i, asOf))
    .filter((r): r is RenewalInput => r !== null);
  return [...explicit, ...fromItems];
}

/** The renewal date on or after `asOf`. */
export function nextRenewal(r: Pick<RenewalInput, "renewsOn" | "every">, asOf: PlainDate): IsoDate {
  const first = parseDate(r.renewsOn, "renewal.renewsOn");
  let d = first;
  for (let k = 1; compareDates(d, asOf) < 0; k++) {
    d = r.every.unit === "week" ? first.add({ weeks: k * r.every.n }) : first.add({ months: k * r.every.n });
  }
  return d.toString();
}

/** Cost per year: amount × 12 ÷ months, or × 52 ÷ weeks, rounded to the nearest cent. */
export function annualCents(amountCents: Cents, every: RenewalInput["every"]): Cents {
  return every.unit === "week"
    ? divRoundHalfUp(amountCents * 52, every.n)
    : divRoundHalfUp(amountCents * 12, every.n);
}

/** 26 weeks is 6 months (rule 11 "every 6 months or less often"). */
export const BIG_RENEWAL_MIN_WEEKS = 26;

export function isBigRenewal(r: Pick<RenewalInput, "every">): boolean {
  return r.every.unit === "month" ? r.every.n >= BIG_RENEWAL_MIN_MONTHS : r.every.n >= BIG_RENEWAL_MIN_WEEKS;
}

export type DeadlineKind = "decision" | "cancel";

/** The earliest decision or cancel-by deadline on or after `asOf` (a decision wins a tie), or null. */
export function nextDeadline(
  r: Pick<RenewalInput, "decisionBy" | "cancelBy">,
  asOf: PlainDate,
): { date: IsoDate; kind: DeadlineKind } | null {
  const candidates: { date: PlainDate; kind: DeadlineKind }[] = [];
  if (r.decisionBy != null)
    candidates.push({ date: parseDate(r.decisionBy, "renewal deadline"), kind: "decision" });
  if (r.cancelBy != null)
    candidates.push({ date: parseDate(r.cancelBy, "renewal deadline"), kind: "cancel" });
  const [first] = candidates
    .filter((c) => compareDates(c.date, asOf) >= 0)
    .sort((a, b) => compareDates(a.date, b.date));
  return first ? { date: first.date.toString(), kind: first.kind } : null;
}

/** The date of `nextDeadline`, or null. */
export function actBy(r: Pick<RenewalInput, "decisionBy" | "cancelBy">, asOf: PlainDate): IsoDate | null {
  return nextDeadline(r, asOf)?.date ?? null;
}

export interface RenewalRow {
  id: string;
  itemId: string | null;
  name: string;
  category: RenewalCategory;
  owner: OwnerKey;
  amountCents: Cents;
  every: RenewalInput["every"];
  annualCents: Cents;
  renewsOn: IsoDate;
  /** Renewal − 30 days. */
  shopAroundOn: IsoDate;
  /** An enrollment or plan-choice deadline, as given. */
  decisionBy: IsoDate | null;
  /** The earliest upcoming decision or cancel-by deadline. */
  actBy: IsoDate | null;
  /** Whether `actBy` is a plan-choice deadline ("Decide by") or a cancel-by date ("Cancel by …?"). */
  actByKind: DeadlineKind | null;
  /** `actBy` if there is one, otherwise the renewal date. Rows sort by it. */
  nextActionOn: IsoDate;
  autoRenews: RenewalInput["autoRenews"];
  big: boolean;
  /**
   * Days before the renewal that scheduled reminders go out: 30, 7 and 0 for big renewals, else empty.
   * Rule 11 also sends a reminder to a monthly subscription when its price changes; that one is driven by
   * the price-up flag (`priceUp`), not a fixed offset, so it is not listed here.
   */
  reminderOffsetsDays: number[];
  priceUp: boolean;
  /** Annualized increase, when `priceUp`. */
  annualIncreaseCents: Cents;
  markedPossiblyUnused: boolean;
  sources: RenewalInput["sources"];
  foundAutomatically: boolean;
}

export interface RenewalsSummary {
  count: number;
  /** The sum of each item's annualized cost. */
  yearlyCents: Cents;
  /** Yearly ÷ 12, rounded to the nearest cent ("about $566 a month"). */
  monthlyAverageCents: Cents;
  /** Big renewals dated within 90 days, plus plan decisions due in that time. */
  next90Days: { count: number; cents: Cents; planDecisions: number; ids: string[] };
  /** Annualized increase of items whose price-up flag shows. */
  priceIncreaseYearlyCents: Cents;
  /** Annual cost of items the household marked as possibly unused. */
  couldSaveYearlyCents: Cents;
  /** Items found from email, CSV or bank (not added by hand). */
  foundAutomatically: number;
  /** Sorted by the next action date, then id. */
  rows: RenewalRow[];
  countsByCategory: Record<RenewalCategory, number>;
}

export function renewalRow(r: RenewalInput, asOf: PlainDate): RenewalRow {
  const renewsOn = parseDate(nextRenewal(r, asOf));
  const act = nextDeadline(r, asOf);
  const big = isBigRenewal(r);
  const priceUp = priceUpShowing(r, asOf);
  const annual = annualCents(r.amountCents, r.every);
  return {
    id: r.id,
    itemId: r.itemId ?? null,
    name: r.name,
    category: r.category,
    owner: r.owner,
    amountCents: r.amountCents,
    every: r.every,
    annualCents: annual,
    renewsOn: renewsOn.toString(),
    shopAroundOn: renewsOn.subtract({ days: SHOP_AROUND_DAYS }).toString(),
    decisionBy: r.decisionBy ?? null,
    actBy: act?.date ?? null,
    actByKind: act?.kind ?? null,
    nextActionOn: act?.date ?? renewsOn.toString(),
    autoRenews: r.autoRenews,
    big,
    reminderOffsetsDays: big ? [...BIG_RENEWAL_REMINDER_OFFSETS] : [],
    priceUp,
    annualIncreaseCents: priceUp ? annual - annualCents(r.previousAmountCents as Cents, r.every) : 0,
    markedPossiblyUnused: r.markedPossiblyUnused ?? false,
    sources: [...r.sources],
    foundAutomatically: r.sources.some((s) => s !== "manual"),
  };
}

export function renewalsSummary(input: EngineInput): RenewalsSummary {
  const asOf = parseDate(input.asOf, "asOf");
  const horizon = asOf.add({ days: BIG_RENEWAL_WINDOW_DAYS });
  const within = (d: IsoDate) => compareDates(parseDate(d), horizon) <= 0;
  const rows = renewalList(input)
    .map((r) => renewalRow(r, asOf))
    .sort((a, b) => compareStrings(a.nextActionOn, b.nextActionOn) || compareStrings(a.id, b.id));
  const big = rows.filter((r) => r.big && within(r.renewsOn));
  const planDecisions = rows.filter(
    (r) =>
      !r.big &&
      r.decisionBy !== null &&
      compareDates(parseDate(r.decisionBy), asOf) >= 0 &&
      within(r.decisionBy),
  );
  const yearlyCents = sumCents(rows.map((r) => r.annualCents));
  const countsByCategory: Record<RenewalCategory, number> = {
    insurance: 0,
    subscription: 0,
    membership: 0,
    vehicle_home: 0,
  };
  for (const r of rows) countsByCategory[r.category]++;
  return {
    count: rows.length,
    yearlyCents,
    monthlyAverageCents: divRoundHalfUp(yearlyCents, 12),
    next90Days: {
      count: big.length,
      cents: sumCents(big.map((r) => r.amountCents)),
      planDecisions: planDecisions.length,
      ids: big.map((r) => r.id),
    },
    priceIncreaseYearlyCents: sumCents(rows.map((r) => r.annualIncreaseCents)),
    couldSaveYearlyCents: sumCents(rows.filter((r) => r.markedPossiblyUnused).map((r) => r.annualCents)),
    foundAutomatically: rows.filter((r) => r.foundAutomatically).length,
    rows,
    countsByCategory,
  };
}
