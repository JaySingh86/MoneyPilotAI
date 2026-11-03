// The engine input projection (BACKEND_PLAN §7.2, WP-12): reads a household's rows inside a caller-provided
// transaction and shapes them into an `EngineInput`. It copies and maps; it never computes an amount or
// a date (hard rule 4). Shared by the planning API and the `plan.recompute` job, so both see the same plan.
//
// Mapping decisions (docs/agents/QUESTIONS.md Q-052, Q-054, Q-056):
// - Owners are a member's user id, `both` or `split`. Item and goal ids are the DB uuids.
// - An item with a renewal date (`renewal_details.coverage_end`) also becomes a `RenewalInput` that points
//   at the item (`itemId`), so it is listed once. Its `every` comes from the item's schedule.
// - `sources` = the item's source plus the sources of its amount history (Q-054).
// - Renewal-only items (`on_bills_page = false`) are ordinary engine items: they count in the runway and
//   are left out of the bills averages by the engine (rule 17).
import { sql } from "drizzle-orm";
import {
  ESTIMATE_HISTORY_SIZE,
  daysBetween,
  householdDate,
  itemAmount,
  parseDate,
  scheduleFromRRule,
  type EngineInput,
  type GoalInput,
  type ItemAmount,
  type ItemInput,
  type ItemKind,
  type ItemSource,
  type OccurrenceInput,
  type PlannedExpenseInput,
  type RenewalCategory,
  type RenewalInput,
  type Schedule,
  type WeekendRule,
} from "@mp/engine";
import type { Tx } from "../tx";

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function cents(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("money out of range");
  return n;
}
const centsOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : cents(v));

/** Plans and what-if dates must lie within this many days of the household's local today (abuse bound). */
export const MAX_PLAN_OFFSET_DAYS = 400;

/** A requested date outside the allowed range. The message names no date. */
export class PlanDateRangeError extends Error {
  override readonly name = "PlanDateRangeError";
}

/** Whether `date` is within +-400 days of `today` (both `YYYY-MM-DD`). */
export function withinPlanRange(today: string, date: string): boolean {
  return Math.abs(daysBetween(parseDate(today), parseDate(date))) <= MAX_PLAN_OFFSET_DAYS;
}

export type PlanNotReadyReason = "no_primary_income" | "no_balance";

export type LoadedPlanInput =
  | {
      ready: true;
      householdId: string;
      input: EngineInput;
      /** The household-local date of `nowIso`. */
      today: string;
      /**
       * Items whose amount is unknown (Q-107: the API no longer accepts them, but older rows may exist).
       * They are planned at $0, so the plan carries a `data_missing` flag for each instead of a silent $0.
       */
      dataMissing: string[];
    }
  | { ready: false; householdId: string; reason: PlanNotReadyReason; asOf: string; today: string };

export interface LoadOptions {
  /** UTC instant as ISO 8601. The household-local date is derived from it. */
  nowIso: string;
  /** Plan as of this household-local date instead of today. */
  asOf?: string | undefined;
  /**
   * For readers that need neither a primary income nor a balance (renewals, bills averages): a household
   * that has neither yet still loads, with placeholders the engine never reads for those figures.
   */
  lenient?: boolean | undefined;
}

const RENEWAL_CATEGORIES: readonly string[] = ["insurance", "subscription", "membership", "vehicle_home"];
const KIND_CATEGORY: Readonly<Partial<Record<ItemKind, RenewalCategory>>> = {
  insurance: "insurance",
  subscription: "subscription",
  membership: "membership",
  registration: "vehicle_home",
};

function owner(ownerType: unknown, ownerUserId: unknown): string {
  return ownerType === "member" ? str(ownerUserId) : str(ownerType);
}

/** How often an item bills, for the renewals screen (the engine's own rule for subscription items). */
function every(schedule: Schedule): RenewalInput["every"] {
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

/**
 * An item with no known amount is planned at $0 rather than dropped (dropping would hide the bill), and
 * reported in `missing` so the plan can flag it.
 */
function amountOf(row: Row, history: number[], missing: string[]): ItemAmount {
  const type = str(row.amount_type);
  const stored = centsOrNull(row.amount_cents);
  if (type === "estimated") {
    if (history.length === 0 && stored === null) missing.push(str(row.id));
    return { type: "estimated", historyCents: history.length > 0 ? history : [stored ?? 0] };
  }
  if (stored === null) missing.push(str(row.id));
  if (type === "statement") return { type: "statement", lastStatementCents: stored ?? 0 };
  return { type: "fixed", cents: stored ?? 0 };
}

/** Loads the engine input for a household, or says why it cannot be planned yet. */
export async function loadEngineInput(
  tx: Tx,
  householdId: string,
  options: LoadOptions,
): Promise<LoadedPlanInput | null> {
  const hh = (
    await tx.execute<Row>(sql`select timezone, cushion_cents::text as cushion_cents,
        primary_income_item_id from households where id = ${householdId}`)
  ).rows[0];
  if (!hh) return null;
  const timezone = str(hh.timezone);
  const today = householdDate(options.nowIso, timezone);
  const asOf = options.asOf ?? today;
  if (options.asOf !== undefined && !withinPlanRange(today, options.asOf)) {
    throw new PlanDateRangeError("asOf is outside the allowed range");
  }

  const primary = strOrNull(hh.primary_income_item_id);
  if (!primary && !options.lenient)
    return { ready: false, householdId, reason: "no_primary_income", asOf, today };

  const balance = (
    await tx.execute<Row>(sql`select amount_cents::text as amount_cents, as_of::text as as_of
      from balances where household_id = ${householdId} and as_of <= ${asOf}::date
      order by as_of desc, created_at desc, id desc limit 1`)
  ).rows[0];
  if (!balance && !options.lenient) return { ready: false, householdId, reason: "no_balance", asOf, today };

  const itemRows = (
    await tx.execute<Row>(sql`select i.id, i.name, i.direction, i.kind, i.category, i.amount_type,
        i.amount_cents::text as amount_cents, i.rrule, i.dtstart::text as dtstart, i.until::text as until,
        i.weekend_rule, i.owner_type, i.owner_user_id, i.status, i.source, i.paid_from,
        i.marked_possibly_unused, i.subcategory, i.movable, i.on_bills_page,
        r.item_id is not null as has_renewal, r.auto_renews, r.coverage_end::text as coverage_end,
        r.cancel_by::text as cancel_by, r.decision_by::text as decision_by,
        r.previous_amount_cents::text as previous_amount_cents, r.price_changed_on::text as price_changed_on
      from recurring_items i left join renewal_details r on r.item_id = i.id
      where i.household_id = ${householdId} and i.deleted_at is null order by i.id`)
  ).rows;

  const historyRows = (
    await tx.execute<Row>(sql`select item_id, occurred_on::text as occurred_on, amount_cents::text as amount_cents,
        source from item_amount_history where household_id = ${householdId}
      order by item_id, occurred_on, created_at, id`)
  ).rows;
  const amounts = new Map<string, Map<string, number>>(); // item → date → amount (first source per date wins)
  const historySources = new Map<string, Set<string>>();
  for (const h of historyRows) {
    const id = str(h.item_id);
    const byDate = amounts.get(id) ?? new Map<string, number>();
    const date = str(h.occurred_on);
    if (!byDate.has(date)) byDate.set(date, cents(h.amount_cents));
    amounts.set(id, byDate);
    const set = historySources.get(id) ?? new Set<string>();
    set.add(str(h.source));
    historySources.set(id, set);
  }
  const historyOf = (id: string): number[] =>
    [...(amounts.get(id)?.values() ?? [])].slice(-ESTIMATE_HISTORY_SIZE);

  const dataMissing: string[] = [];
  const items: ItemInput[] = [];
  const renewals: RenewalInput[] = [];
  for (const r of itemRows) {
    const id = str(r.id);
    const schedule = scheduleFromRRule({
      rrule: str(r.rrule),
      dtstart: str(r.dtstart),
      until: strOrNull(r.until),
    });
    const sources = [...new Set([str(r.source), ...(historySources.get(id) ?? [])])] as ItemSource[];
    const item: ItemInput = {
      id,
      name: str(r.name),
      direction: r.direction as ItemInput["direction"],
      kind: r.kind as ItemKind,
      owner: owner(r.owner_type, r.owner_user_id),
      amount: amountOf(r, historyOf(id), dataMissing),
      schedule,
      weekendRule: r.weekend_rule as WeekendRule,
      paidFrom: r.paid_from as "account" | "payroll",
      status: r.status as NonNullable<ItemInput["status"]>,
      sources,
      previousAmountCents: centsOrNull(r.previous_amount_cents),
      priceChangedOn: strOrNull(r.price_changed_on),
      markedPossiblyUnused: r.marked_possibly_unused === true,
      subcategory: strOrNull(r.subcategory),
      onBillsPage: r.on_bills_page === true,
    };
    if (r.movable === true || r.movable === false) item.movable = r.movable;
    items.push(item);

    // A renewal needs a renewal date (Q-052). Items with only a price change stay plain items.
    const renewsOn = strOrNull(r.coverage_end);
    const category = RENEWAL_CATEGORIES.includes(str(r.category))
      ? (str(r.category) as RenewalCategory)
      : KIND_CATEGORY[item.kind];
    if (renewsOn && category && item.direction === "outflow" && item.status !== "ended") {
      renewals.push({
        id,
        itemId: id,
        name: item.name,
        category,
        owner: item.owner,
        amountCents: itemAmount(item).cents,
        every: every(schedule),
        renewsOn,
        autoRenews: r.auto_renews as RenewalInput["autoRenews"],
        sources,
        paidFrom: item.paidFrom ?? "account",
        previousAmountCents: item.previousAmountCents ?? null,
        priceChangedOn: item.priceChangedOn ?? null,
        markedPossiblyUnused: item.markedPossiblyUnused ?? false,
        subcategory: item.subcategory ?? null,
        decisionBy: strOrNull(r.decision_by),
        cancelBy: strOrNull(r.cancel_by),
      });
    }
  }

  const occurrences: OccurrenceInput[] = (
    await tx.execute<Row>(sql`select o.id, o.item_id, o.scheduled_on::text as scheduled_on, o.due_on::text as due_on,
        o.status, o.actual_amount_cents::text as actual_amount_cents, o.paid_on::text as paid_on
      from occurrences o join recurring_items i on i.id = o.item_id
      where o.household_id = ${householdId} and i.deleted_at is null order by o.item_id, o.scheduled_on`)
  ).rows.map((o) => ({
    id: str(o.id),
    itemId: str(o.item_id),
    scheduledOn: str(o.scheduled_on),
    dueOn: str(o.due_on),
    status: o.status as OccurrenceInput["status"],
    actualAmountCents: centsOrNull(o.actual_amount_cents),
    paidOn: strOrNull(o.paid_on),
  }));

  const plannedExpenses: PlannedExpenseInput[] = (
    await tx.execute<Row>(sql`select id, name, amount_cents::text as amount_cents, due_on::text as due_on,
        owner_type, owner_user_id, goal_id, status from planned_expenses
      where household_id = ${householdId} order by id`)
  ).rows.map((p) => ({
    id: str(p.id),
    name: str(p.name),
    owner: owner(p.owner_type, p.owner_user_id),
    amountCents: cents(p.amount_cents),
    dueOn: str(p.due_on),
    status: p.status as PlannedExpenseInput["status"],
    goalId: strOrNull(p.goal_id),
  }));

  const goals: GoalInput[] = (
    await tx.execute<Row>(sql`select id, name, type, target_cents::text as target_cents,
        saved_cents::text as saved_cents, monthly_cents::text as monthly_cents, target_date::text as target_date,
        is_emergency_fund from goals
      where household_id = ${householdId} and deleted_at is null and status <> 'archived' order by id`)
  ).rows.map((g) => ({
    id: str(g.id),
    name: str(g.name),
    type: g.type as "savings" | "planned_expense",
    targetCents: cents(g.target_cents),
    savedCents: cents(g.saved_cents),
    monthlyCents: cents(g.monthly_cents),
    targetDate: strOrNull(g.target_date),
    emergencyFund: g.is_emergency_fund === true,
  }));

  return {
    ready: true,
    householdId,
    dataMissing,
    today,
    input: {
      asOf,
      timezone,
      cushionCents: cents(hh.cushion_cents),
      startingBalance: balance
        ? { cents: cents(balance.amount_cents), asOf: str(balance.as_of) }
        : { cents: 0, asOf },
      primaryIncomeItemId: primary ?? "",
      items,
      occurrences,
      plannedExpenses,
      goals,
      renewals,
    },
  };
}
