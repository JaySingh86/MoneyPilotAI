// Seed loader, part 2 (WP-06): the Rivera household's items, renewals, goals, planned expenses, balance
// and occurrences, from design/fixtures/rivera-household.json. Run after `seedFixture` (members first).
// Rows are written as the household creator through mp_api, the way the API would write them.
//
// Mapping decisions (see docs/agents/QUESTIONS.md Q-050 to Q-054):
// - Every renewal is a recurring item (BACKEND_PLAN §7.5). r-car is the existing car insurance item
//   (b-carins); the other eight are renewal-only items with `on_bills_page = false` (Q-020).
// - Past occurrences (due on or before the balance date) are marked paid/received: the household's
//   money already moved, and a still-`scheduled` past row would raise the engine's `overdue` flag.
import { sql } from "drizzle-orm";
import { expandSchedule, parseDate, scheduleToRRule, type Schedule, type Weekday } from "@mp/engine";
import { materializeHousehold } from "../items/materialize";
import type { ApiDb, Tx, WorkerDb } from "../tx";
import { fixtureUuid, type SeedResult } from "./rivera";
import { seedTasks } from "./tasks";

/**
 * Deterministic id of a seeded row, scoped to the household so two seeded households (for example in
 * tests) never share a primary key.
 */
export function planningUuid(householdId: string, fixtureId: string): string {
  return fixtureUuid(`${householdId}:${fixtureId}`);
}

/** Lower bound for the fixture's unanchored monthly schedules (they carry no start date). */
export const SERIES_START = "2026-01-01";

type Rec = Record<string, unknown>;

function rec(value: unknown, path: string): Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`fixture: ${path} must be an object`);
  return value as Rec;
}
function list(value: unknown, path: string): Rec[] {
  if (!Array.isArray(value)) throw new Error(`fixture: ${path} must be an array`);
  return value.map((v, i) => rec(v, `${path}[${i}]`));
}
function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`fixture: ${path} must be a non-empty string`);
  return value;
}
function optStr(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : str(value, path);
}
function int(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`fixture: ${path} must be an integer`);
  return value;
}
function optInt(value: unknown, path: string): number | null {
  return value === undefined || value === null ? null : int(value, path);
}

export type ItemKind =
  "bill" | "subscription" | "insurance" | "membership" | "registration" | "loan" | "income" | "other";
type ItemSource = "manual" | "csv" | "email" | "bank";

export interface SeedItem {
  fixtureId: string;
  ownerMemberId: string;
  direction: "inflow" | "outflow";
  kind: ItemKind;
  category: string;
  name: string;
  providerName: string | null;
  amountType: "fixed" | "estimated" | "statement";
  amountCents: number | null;
  /** Estimated items: amounts oldest to newest (the last three become amount history). */
  historyCents: number[];
  schedule: Schedule;
  /** The primary source, and the other sources the item was also seen in (`email+csv`). */
  source: ItemSource;
  extraSources: ItemSource[];
  paidFrom: "account" | "payroll";
  markedPossiblyUnused: boolean;
  subcategory: string | null;
  onBillsPage: boolean;
  accountLast4: string | null;
  renewal: SeedRenewal | null;
}

export interface SeedRenewal {
  autoRenews: "yes" | "no" | "rolls_over";
  coverageEnd: string | null;
  cancelBy: string | null;
  decisionBy: string | null;
  previousAmountCents: number | null;
  priceChangedOn: string | null;
}

export interface SeedGoal {
  fixtureId: string;
  name: string;
  type: "savings" | "planned_expense";
  targetCents: number;
  savedCents: number;
  monthlyCents: number;
  targetDate: string | null;
  isEmergencyFund: boolean;
  colorSlot: number;
}

export interface SeedPlannedExpense {
  fixtureId: string;
  name: string;
  amountCents: number;
  dueOn: string;
  owner: string;
}

export interface PlanningSeedPlan {
  today: string;
  primaryIncomeFixtureId: string;
  balance: { amountCents: number; asOf: string; source: "manual" | "csv" | "bank" };
  items: SeedItem[];
  goals: SeedGoal[];
  plannedExpenses: SeedPlannedExpense[];
}

const CATEGORY_BY_ITEM: Readonly<Record<string, string>> = {
  "b-car": "transport",
  "b-phone": "utilities",
  "b-rent": "housing",
  "b-daycare": "childcare",
  "b-power": "utilities",
  "b-internet": "utilities",
  "b-card": "debt",
  "b-water": "utilities",
};

function categoryFor(id: string, kind: ItemKind): string {
  const override = CATEGORY_BY_ITEM[id];
  if (override) return override;
  if (kind === "income") return "income";
  if (kind === "subscription" || kind === "insurance" || kind === "membership") return kind;
  return "other";
}

/** `email+csv` → primary `email`, extra `csv`. */
function sources(value: unknown, path: string): { source: ItemSource; extra: ItemSource[] } {
  const parts = str(value, path).split("+");
  const ok = (s: string): s is ItemSource => ["manual", "csv", "email", "bank"].includes(s);
  const all = parts.filter(ok);
  const [first, ...extra] = all;
  if (!first || all.length !== parts.length) throw new Error(`fixture: ${path} has an unknown source`);
  return { source: first, extra };
}

function toSchedule(value: unknown, path: string): Schedule {
  const s = rec(value, path);
  switch (s.type) {
    case "biweekly":
      return { type: "every_n_weeks", n: 2, dtstart: str(s.anchor, `${path}.anchor`) };
    case "monthly":
      return s.day === "last"
        ? { type: "monthly_last_day", dtstart: SERIES_START }
        : { type: "monthly_day", day: int(s.day, `${path}.day`), dtstart: SERIES_START };
    case "monthly_last_weekday":
      return {
        type: "monthly_last_weekday",
        weekday: str(s.weekday, `${path}.weekday`) as Weekday,
        dtstart: SERIES_START,
      };
    case "every_n_months":
      return { type: "every_n_months", n: int(s.n, `${path}.n`), dtstart: str(s.next, `${path}.next`) };
    default:
      throw new Error(`fixture: ${path}.type is not a known schedule`);
  }
}

const RENEWAL_ITEM_LINKS: Readonly<Record<string, string>> = { "r-car": "b-carins" };

function fixtureItem(raw: Rec, direction: "inflow" | "outflow", path: string): SeedItem {
  const id = str(raw.id, `${path}.id`);
  const kind = (optStr(raw.kind, `${path}.kind`) ?? (direction === "inflow" ? "income" : "bill")) as ItemKind;
  const estimate = raw.estimate === undefined ? null : rec(raw.estimate, `${path}.estimate`);
  const amountCents = optInt(raw.amountCents, `${path}.amountCents`);
  let amountType: SeedItem["amountType"] = "fixed";
  let history: number[] = [];
  let storedAmount = amountCents;
  if (amountCents === null) {
    if (estimate?.historyCents !== undefined) {
      amountType = "estimated";
      history = (estimate.historyCents as unknown[]).map((c, i) =>
        int(c, `${path}.estimate.historyCents[${i}]`),
      );
      storedAmount = null;
    } else if (estimate?.fromLastStatementCents !== undefined) {
      amountType = "statement";
      storedAmount = int(estimate.fromLastStatementCents, `${path}.estimate.fromLastStatementCents`);
    } else {
      throw new Error(`fixture: ${path} has no amount`);
    }
  }
  const src = sources(raw.source, `${path}.source`);
  const previous = optInt(raw.previousAmountCents, `${path}.previousAmountCents`);
  return {
    fixtureId: id,
    ownerMemberId: str(raw.owner, `${path}.owner`),
    direction,
    kind,
    category: categoryFor(id, kind),
    name: str(raw.name, `${path}.name`),
    providerName: null,
    amountType,
    amountCents: storedAmount,
    historyCents: history,
    schedule: toSchedule(raw.schedule, `${path}.schedule`),
    source: src.source,
    extraSources: src.extra,
    paidFrom: "account",
    markedPossiblyUnused: raw.markedPossiblyUnused === true,
    subcategory: optStr(raw.subcategory, `${path}.subcategory`),
    onBillsPage: true,
    accountLast4: null,
    // A price change on a bill (the streaming bundle) lives in renewal_details (BACKEND_PLAN §5.2).
    renewal:
      previous === null
        ? null
        : {
            autoRenews: "yes",
            coverageEnd: null,
            cancelBy: null,
            decisionBy: null,
            previousAmountCents: previous,
            priceChangedOn: optStr(raw.priceChangedOn, `${path}.priceChangedOn`),
          },
  };
}

function renewalSchedule(frequency: string, renewsOn: string, path: string): Schedule {
  switch (frequency) {
    case "6_months":
      return { type: "every_n_months", n: 6, dtstart: renewsOn };
    case "yearly":
      return { type: "yearly", dtstart: renewsOn };
    case "monthly_payroll":
      // Taken from pay every month; the plan-year renewal date is kept in renewal_details.coverage_end.
      return { type: "monthly_day", day: parseDate(renewsOn, path).day, dtstart: renewsOn };
    default:
      throw new Error(`fixture: ${path}.frequency is not known`);
  }
}

const RENEWAL_KINDS: Readonly<Record<string, ItemKind>> = {
  insurance: "insurance",
  subscription: "subscription",
  membership: "membership",
  vehicle_home: "registration",
};

/** Validates the parts of the fixture this seed uses and maps them to rows. Pure. */
export function planPlanningSeed(fixture: unknown): PlanningSeedPlan {
  const root = rec(fixture, "root");
  const household = rec(root.household, "household");
  const balance = rec(root.balance, "balance");
  const items = [
    ...list(root.incomes, "incomes").map((r, i) => fixtureItem(r, "inflow", `incomes[${i}]`)),
    ...list(root.bills, "bills").map((r, i) => fixtureItem(r, "outflow", `bills[${i}]`)),
  ];
  const byId = new Map(items.map((i) => [i.fixtureId, i]));

  for (const [i, r] of list(root.renewals, "renewals").entries()) {
    const path = `renewals[${i}]`;
    const id = str(r.id, `${path}.id`);
    const renewsOn = str(r.renewsOn, `${path}.renewsOn`);
    const auto = r.autoRenew === "rolls_over" ? "rolls_over" : r.autoRenew === true ? "yes" : "no";
    const renewal: SeedRenewal = {
      autoRenews: auto,
      coverageEnd: renewsOn,
      cancelBy: optStr(r.cancelBy, `${path}.cancelBy`),
      decisionBy: optStr(r.decisionBy, `${path}.decisionBy`),
      previousAmountCents: optInt(r.previousAmountCents, `${path}.previousAmountCents`),
      priceChangedOn: null,
    };
    const linked = RENEWAL_ITEM_LINKS[id];
    if (linked !== undefined) {
      const item = byId.get(linked);
      if (!item) throw new Error(`fixture: ${path} links to ${linked}, which is not an item`);
      item.renewal = renewal;
      item.providerName = optStr(r.provider, `${path}.provider`);
      continue;
    }
    const category = str(r.category, `${path}.category`);
    const kind = RENEWAL_KINDS[category];
    if (!kind) throw new Error(`fixture: ${path}.category is not known`);
    const frequency = str(r.frequency, `${path}.frequency`);
    const src = sources(r.source, `${path}.source`);
    const item: SeedItem = {
      fixtureId: id,
      ownerMemberId: str(r.owner, `${path}.owner`),
      direction: "outflow",
      kind,
      category,
      name: str(r.name, `${path}.name`),
      providerName: optStr(r.provider, `${path}.provider`),
      amountType: "fixed",
      amountCents: int(r.amountCents, `${path}.amountCents`),
      historyCents: [],
      schedule: renewalSchedule(frequency, renewsOn, path),
      source: src.source,
      extraSources: src.extra,
      paidFrom: frequency === "monthly_payroll" ? "payroll" : "account",
      markedPossiblyUnused: r.markedPossiblyUnused === true,
      subcategory: null,
      onBillsPage: false,
      accountLast4: optStr(r.policyLast4, `${path}.policyLast4`),
      renewal,
    };
    items.push(item);
    byId.set(id, item);
  }

  const primary = str(household.primaryIncomeId, "household.primaryIncomeId");
  if (!byId.has(primary)) throw new Error("fixture: household.primaryIncomeId is not an item");

  return {
    today: str(root.today, "today"),
    primaryIncomeFixtureId: primary,
    balance: {
      amountCents: int(balance.amountCents, "balance.amountCents"),
      asOf: str(balance.asOf, "balance.asOf"),
      source: str(balance.source, "balance.source") as "manual" | "csv" | "bank",
    },
    items,
    goals: list(root.goals, "goals").map((g, i) => ({
      fixtureId: str(g.id, `goals[${i}].id`),
      name: str(g.name, `goals[${i}].name`),
      type: g.type === "planned_expense" ? "planned_expense" : "savings",
      targetCents: int(g.targetCents, `goals[${i}].targetCents`),
      savedCents: int(g.savedCents, `goals[${i}].savedCents`),
      monthlyCents: optInt(g.monthlyCents, `goals[${i}].monthlyCents`) ?? 0,
      targetDate: optStr(g.targetDate, `goals[${i}].targetDate`),
      isEmergencyFund: g.emergencyFund === true,
      colorSlot: i + 1,
    })),
    plannedExpenses: list(root.plannedExpenses, "plannedExpenses").map((p, i) => ({
      fixtureId: str(p.id, `plannedExpenses[${i}].id`),
      name: str(p.name, `plannedExpenses[${i}].name`),
      amountCents: int(p.amountCents, `plannedExpenses[${i}].amountCents`),
      dueOn: str(p.date, `plannedExpenses[${i}].date`),
      owner: str(p.owner, `plannedExpenses[${i}].owner`),
    })),
  };
}

/** The last `count` scheduled dates on or before `today`, oldest first. */
function recentDates(schedule: Schedule, today: string, count: number): string[] {
  const end = parseDate(today, "today");
  const dates = expandSchedule(schedule, end.subtract({ days: 800 }), end);
  return dates.slice(-count).map((d) => d.toString());
}

export interface PlanningSeedResult {
  /** False when the household already had items (re-run). */
  created: boolean;
  items: number;
  occurrences: number;
}

async function insertItem(
  tx: Tx,
  householdId: string,
  creatorId: string,
  userIdForMember: (member: string) => string,
  item: SeedItem,
): Promise<void> {
  const rr = scheduleToRRule(item.schedule);
  const itemId = planningUuid(householdId, item.fixtureId);
  await tx.execute(sql`insert into recurring_items
      (id, household_id, direction, kind, category, name, provider_name, amount_type, amount_cents, rrule,
       dtstart, until, owner_type, owner_user_id, source, account_last4, paid_from, marked_possibly_unused,
       subcategory, on_bills_page, created_by)
    values (${itemId}, ${householdId}, ${item.direction}::item_direction, ${item.kind}::item_kind,
       ${item.category}, ${item.name}, ${item.providerName}, ${item.amountType}, ${item.amountCents},
       ${rr.rrule}, ${rr.dtstart}::date, ${rr.until}::date, 'member'::owner_type,
       ${userIdForMember(item.ownerMemberId)}, ${item.source}, ${item.accountLast4}, ${item.paidFrom},
       ${item.markedPossiblyUnused}, ${item.subcategory}, ${item.onBillsPage}, ${creatorId})`);
  if (item.renewal) {
    const r = item.renewal;
    await tx.execute(sql`insert into renewal_details
        (item_id, household_id, auto_renews, coverage_end, cancel_by, decision_by, previous_amount_cents,
         price_changed_on)
      values (${itemId}, ${householdId}, ${r.autoRenews}, ${r.coverageEnd}::date, ${r.cancelBy}::date,
         ${r.decisionBy}::date, ${r.previousAmountCents}, ${r.priceChangedOn}::date)`);
  }
}

/** Amount history: the last three amounts of an estimated item, and the extra sources an item was seen in. */
async function insertHistory(tx: Tx, householdId: string, today: string, item: SeedItem): Promise<void> {
  const itemId = planningUuid(householdId, item.fixtureId);
  const add = (occurredOn: string, cents: number, source: ItemSource) =>
    tx.execute(sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
      values (${householdId}, ${itemId}, ${occurredOn}::date, ${cents}, ${source})`);
  if (item.amountType === "estimated") {
    const amounts = item.historyCents.slice(-3);
    const dates = recentDates(item.schedule, today, amounts.length);
    for (const [i, cents] of amounts.entries()) await add(dates[i] ?? today, cents, item.source);
  }
  const last = recentDates(item.schedule, today, 1)[0];
  if (item.amountCents !== null && last !== undefined) {
    for (const extra of item.extraSources) await add(last, item.amountCents, extra);
  }
}

/**
 * Idempotent: a household whose primary income is set (the last step) is left alone.
 *
 * Rows are written by the role that owns each source (G1 M-2, Q-050): the fixture's CSV and email items and
 * history, the goals and the CSV balance as mp_worker (mp_api may only insert hand-entered rows, and has no
 * write access to goals until WP-13); planned expenses, the primary income, occurrences and their paid
 * marks as the household creator through mp_api.
 */
export async function seedPlanning(
  dbs: { api: ApiDb; worker: WorkerDb },
  seeded: SeedResult,
  fixture: unknown,
): Promise<PlanningSeedResult> {
  const plan = planPlanningSeed(fixture);
  const root = rec(fixture, "root");
  const members = list(root.members, "members");
  const userIds = new Map<string, string>();
  for (const [i, m] of members.entries()) {
    const role = str(m.colorRole, `members[${i}].colorRole`);
    userIds.set(
      str(m.id, `members[${i}].id`),
      role === "partnerA" ? seeded.userIds.creator : seeded.userIds.partner,
    );
  }
  const userIdForMember = (member: string): string => {
    const id = userIds.get(member);
    if (!id) throw new Error(`fixture: unknown member ${member}`);
    return id;
  };
  const householdId = seeded.householdId;
  const creatorId = seeded.userIds.creator;
  const creatorCtx = { userId: creatorId, householdId };

  const state = await dbs.api.withHouseholdTx(creatorCtx, async (tx) => {
    const res = await tx.execute<{ primary_income_item_id: string | null; items: string }>(
      sql`select h.primary_income_item_id,
            (select count(*) from recurring_items i where i.household_id = h.id)::text as items
          from households h where h.id = ${householdId}`,
    );
    return res.rows[0];
  });
  if (state?.primary_income_item_id) {
    await seedTasks(dbs.worker, seeded, fixture, userIdForMember, planningUuid);
    return { created: false, items: 0, occurrences: 0 };
  }
  if (Number(state?.items ?? 0) > 0) {
    throw new Error("The household is partly seeded; reset the database and seed again.");
  }

  await dbs.worker.withJobTx(householdId, async (tx) => {
    for (const item of plan.items) await insertItem(tx, householdId, creatorId, userIdForMember, item);
    for (const item of plan.items) await insertHistory(tx, householdId, plan.today, item);
    for (const g of plan.goals) {
      await tx.execute(sql`insert into goals
          (id, household_id, name, type, target_cents, saved_cents, monthly_cents, target_date, color_slot,
           is_emergency_fund, created_by)
        values (${planningUuid(householdId, g.fixtureId)}, ${householdId}, ${g.name}, ${g.type}, ${g.targetCents},
           ${g.savedCents}, ${g.monthlyCents}, ${g.targetDate}::date, ${g.colorSlot}, ${g.isEmergencyFund},
           ${creatorId})`);
    }
    await tx.execute(sql`insert into balances (household_id, amount_cents, as_of, source, recorded_by)
      values (${householdId}, ${plan.balance.amountCents}, ${plan.balance.asOf}::date, ${plan.balance.source},
         ${creatorId})`);
  });

  const result = await dbs.api.withHouseholdTx(creatorCtx, async (tx) => {
    for (const p of plan.plannedExpenses) {
      const isMember = p.owner !== "both" && p.owner !== "split";
      await tx.execute(sql`insert into planned_expenses
          (id, household_id, name, amount_cents, due_on, owner_type, owner_user_id, created_by)
        values (${planningUuid(householdId, p.fixtureId)}, ${householdId}, ${p.name}, ${p.amountCents}, ${p.dueOn}::date,
           ${isMember ? "member" : p.owner}::owner_type, ${isMember ? userIdForMember(p.owner) : null}, ${creatorId})`);
    }
    const materialized = await materializeHousehold(tx, householdId, plan.today);
    // Money that moved on or before the balance date is history, not a to-do.
    await tx.execute(sql`update occurrences o
        set status = case when i.direction = 'inflow' then 'received' else 'paid' end, paid_on = o.due_on
      from recurring_items i
      where i.id = o.item_id and o.household_id = ${householdId} and o.status = 'scheduled'
        and o.due_on <= ${plan.balance.asOf}::date`);
    await tx.execute(sql`update households set primary_income_item_id = ${planningUuid(householdId, plan.primaryIncomeFixtureId)}
      where id = ${householdId}`);
    return { created: true, items: plan.items.length, occurrences: materialized.inserted };
  });
  await seedTasks(dbs.worker, seeded, fixture, userIdForMember, planningUuid);
  return result;
}
