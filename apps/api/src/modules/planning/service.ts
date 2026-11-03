// Planning reads (BACKEND_PLAN §7.2, §8.2): the plan, what-if, calendar and renewals. The API projects DB
// rows into an engine input (packages/db `loadEngineInput`) and returns what the engine computes. It never
// calculates an amount or a date itself (hard rule 4). Everything here is read-only, except the snapshot row
// `GET /plan` stores for the household's local today (immutable, deduplicated by input hash).
//
// Abuse bounds (security review M1): `asOf`, the calendar month and every date inside a what-if change must
// lie within 400 days of the household's local today. Only today's plan is stored, so a caller cannot grow
// `calc_snapshots` by walking dates.
import {
  AppError,
  type CalendarMonth,
  type Plan,
  type PlanChange,
  type RenewalsSummary,
  type WhatIfResponse,
} from "@mp/contracts";
import {
  loadEngineInput,
  PlanDateRangeError,
  storeSnapshot,
  withinPlanRange,
  type ApiContext,
  type ApiDb,
  type LoadOptions,
  type PlanNotReadyReason,
  type Tx,
} from "@mp/db";
import {
  calendarMonth,
  computeFullPlan,
  EngineError,
  parseDate,
  renewalsSummary,
  whatIf,
  type EngineInput,
  type PlanChange as EngineChange,
  type PlanResult,
  type RenewalRow,
} from "@mp/engine";

export interface PlanningDeps {
  db: ApiDb;
  /** UTC instant as ISO 8601. Calendar dates are derived with the household timezone. */
  now: () => string;
}

export interface PlanActor {
  ctx: ApiContext;
  householdId: string;
}

const NOT_READY: Record<PlanNotReadyReason, string> = {
  no_primary_income: "Choose which income sets your payday before planning.",
  no_balance: "Enter your current balance before planning.",
};

function notFound(what = "Household"): AppError {
  return new AppError("not_found", 404, `${what} not found.`);
}

function outOfRange(inPart: "querystring" | "body", path: string): AppError {
  return new AppError("validation_failed", 400, "A date is too far from today.", {
    fields: [{ in: inPart, path, message: "Must be within 400 days of today" }],
  });
}

/** What the engine rejects about data we already validated: not the caller's fault. */
function dataProblem(err: unknown): never {
  if (err instanceof EngineError) {
    throw new AppError("conflict", 409, "The plan cannot be calculated from the current data.");
  }
  throw err;
}

/** Postgres failures a caller can cause (no membership) become 403, like the other modules. */
function dbProblem(err: unknown): never {
  if (err instanceof PlanDateRangeError) throw outOfRange("querystring", "asOf");
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === "42501") {
      throw new AppError("forbidden", 403, "You do not have access to this household.");
    }
    current = (current as { cause?: unknown }).cause;
  }
  throw err;
}

async function run<T>(deps: PlanningDeps, a: PlanActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return dbProblem(err);
  }
}

interface Loaded {
  input: EngineInput;
  today: string;
  dataMissing: string[];
}

/** Loads the input; throws 404 when the household is missing and 409 `plan_not_ready` before onboarding. */
async function load(
  tx: Tx,
  deps: PlanningDeps,
  a: PlanActor,
  options: Pick<LoadOptions, "asOf" | "lenient"> = {},
): Promise<Loaded> {
  const loaded = await loadEngineInput(tx, a.householdId, { nowIso: deps.now(), ...options });
  if (!loaded) throw notFound();
  if (!loaded.ready) {
    throw new AppError("plan_not_ready", 409, NOT_READY[loaded.reason], { reason: loaded.reason });
  }
  return { input: loaded.input, today: loaded.today, dataMissing: loaded.dataMissing };
}

/** `GET /plan`: computes on read; stores the snapshot when the plan is for today. */
export async function getPlan(deps: PlanningDeps, a: PlanActor, asOf?: string): Promise<Plan> {
  return run(deps, a, async (tx) => {
    const { input, today, dataMissing } = await load(tx, deps, a, { asOf });
    let result: ReturnType<typeof computeFullPlan>;
    try {
      result = computeFullPlan(input);
    } catch (err) {
      return dataProblem(err);
    }
    const snapshotId =
      input.asOf === today ? (await storeSnapshot(tx, a.householdId, input, result)).id : null;
    const d = result.runwayDetail;
    return {
      calcSnapshotId: snapshotId,
      engineVersion: result.engineVersion,
      asOf: result.asOf,
      cushionCents: input.cushionCents,
      window: result.window,
      state: result.state,
      safeToSpendCents: result.safeToSpendCents,
      safeToSpendDisplayCents: result.safeToSpendDisplayCents,
      shortfallDisplayCents: result.shortfallDisplayCents,
      perDayCents: result.perDayCents,
      lowest: result.lowest,
      belowCushionFrom: result.belowCushionFrom,
      belowZeroDates: result.belowZeroDates,
      billsBeforePayday: result.billsBeforePayday,
      runway: result.runway,
      runwayDetail: {
        startingBalanceCents: d.startingBalanceCents,
        startingBalanceAsOf: d.startingBalanceAsOf,
        carriedEvents: d.carriedEvents,
        openingBalanceCents: d.openingBalanceCents,
        excludedEvents: d.excludedEvents,
      },
      // Items with an unknown amount are planned at $0; say so instead of hiding it.
      flags: [
        ...dataMissing.map((id) => ({ code: "data_missing" as const, subjectId: id, date: null })),
        ...result.flags,
      ],
      decisions: result.decisions.map((x) => ({ ...x, aiText: null })),
      shortfallOptions: result.shortfallOptions,
      math: result.math,
    };
  });
}

function summary(plan: PlanResult) {
  return {
    state: plan.state,
    safeToSpendCents: plan.safeToSpendCents,
    safeToSpendDisplayCents: plan.safeToSpendDisplayCents,
    shortfallDisplayCents: plan.shortfallDisplayCents,
    perDayCents: plan.perDayCents,
    lowest: plan.lowest,
    belowCushionFrom: plan.belowCushionFrom,
    belowZeroDates: plan.belowZeroDates,
    math: plan.math,
  };
}

/** The dates a change names, with the body path for the error. */
function changeDates(change: PlanChange): [string, string][] {
  switch (change.type) {
    case "move_occurrence":
      return [["toDate", change.toDate]];
    case "split_planned_expense":
      return [["laterOn", change.laterOn]];
    case "add_transfer":
      return [["on", change.on]];
    default:
      return [];
  }
}

/** The engine's change for an API change: occurrence ids become (item, scheduled date). */
function toEngineChange(change: PlanChange, engineInput: EngineInput): EngineChange {
  switch (change.type) {
    case "move_occurrence":
    case "set_actual_amount": {
      const occurrence = engineInput.occurrences.find((o) => o.id === change.occurrenceId);
      if (!occurrence) throw notFound("Occurrence");
      return change.type === "move_occurrence"
        ? {
            type: "move_occurrence",
            itemId: occurrence.itemId,
            scheduledOn: occurrence.scheduledOn,
            toDate: change.toDate,
          }
        : {
            type: "set_actual_amount",
            itemId: occurrence.itemId,
            scheduledOn: occurrence.scheduledOn,
            amountCents: change.amountCents,
          };
    }
    case "add_transfer":
      return {
        type: "add_transfer",
        amountCents: change.amountCents,
        on: change.on,
        ...(change.fromGoalId ? { fromGoalId: change.fromGoalId } : {}),
      };
    default:
      return change;
  }
}

/** `POST /plan/what-if`: no writes. */
export async function planWhatIf(
  deps: PlanningDeps,
  a: PlanActor,
  changes: PlanChange[],
  asOf?: string,
): Promise<WhatIfResponse> {
  return run(deps, a, async (tx) => {
    const { input, today } = await load(tx, deps, a, { asOf });
    changes.forEach((change, i) => {
      for (const [path, date] of changeDates(change)) {
        if (!withinPlanRange(today, date)) throw outOfRange("body", `changes.${i}.${path}`);
      }
    });
    const engineChanges = changes.map((c) => toEngineChange(c, input));
    // The unchanged plan must calculate: if it does not, the data is at fault (409). After that, anything
    // the engine rejects comes from the changes themselves (an unknown item, a split larger than the
    // expense, ...) and is the caller's mistake (400).
    let before: ReturnType<typeof computeFullPlan>;
    try {
      before = computeFullPlan(input);
    } catch (err) {
      return dataProblem(err);
    }
    try {
      const result = whatIf(input, engineChanges);
      return { before: summary(before), after: summary(result.plan), diff: result.diff };
    } catch (err) {
      if (err instanceof EngineError) {
        throw new AppError("validation_failed", 400, "A change does not apply to this household's plan.", {
          fields: [{ in: "body", path: "changes", message: "A change does not apply" }],
        });
      }
      throw err;
    }
  });
}

export async function getCalendar(
  deps: PlanningDeps,
  a: PlanActor,
  month: string,
  owner: string | undefined,
  asOf?: string,
): Promise<CalendarMonth> {
  return run(deps, a, async (tx) => {
    const { input, today } = await load(tx, deps, a, { asOf });
    const first = `${month}-01`;
    const last = parseDate(first).add({ months: 1 }).subtract({ days: 1 }).toString();
    // A month is in range when any of its days is within 400 days of today.
    if (!withinPlanRange(today, first) && !withinPlanRange(today, last))
      throw outOfRange("querystring", "month");
    try {
      return calendarMonth(input, month, { owner: owner ?? null });
    } catch (err) {
      return dataProblem(err);
    }
  });
}

export async function listRenewals(
  deps: PlanningDeps,
  a: PlanActor,
  category: string | undefined,
  asOf?: string,
): Promise<{ data: RenewalRow[] }> {
  return run(deps, a, async (tx) => {
    const { input } = await load(tx, deps, a, { asOf, lenient: true });
    try {
      const rows = renewalsSummary(input).rows;
      return { data: category ? rows.filter((r) => r.category === category) : rows };
    } catch (err) {
      return dataProblem(err);
    }
  });
}

export async function getRenewalsSummary(
  deps: PlanningDeps,
  a: PlanActor,
  asOf?: string,
): Promise<RenewalsSummary> {
  return run(deps, a, async (tx) => {
    const { input } = await load(tx, deps, a, { asOf, lenient: true });
    try {
      const { rows: _rows, ...rest } = renewalsSummary(input);
      return rest;
    } catch (err) {
      return dataProblem(err);
    }
  });
}
