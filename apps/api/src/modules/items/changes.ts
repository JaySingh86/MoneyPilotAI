// Transaction-level item, occurrence and planned-expense changes (WP-06, extracted for WP-13). The service
// decides whether a change needs the other member's approval; these functions apply it inside a caller's
// transaction. A proposal that is approved applies through the same functions, credited to the proposer
// (`a.userId`), so a direct edit and an approved one leave the same rows.
import {
  AppError,
  type Item,
  type Occurrence,
  type PatchItem,
  type PatchOccurrence,
  type PlannedExpense,
} from "@mp/contracts";
import { autoCompleteTasks, householdToday, rebuildFutureOccurrences, type Tx } from "@mp/db";
import { EngineError, scheduleToRRule } from "@mp/engine";
import * as repo from "./repo";

export interface ChangeDeps {
  /** UTC instant as ISO 8601. Calendar dates are derived with the household timezone. */
  now: () => string;
}

/**
 * Who a change is credited to (`moved_by`, `marked_by`). Rows that RLS requires to name the signed-in member
 * (audit events, `created_by`) use `auditUserId`: the approver, when a proposal is applied.
 */
export interface ChangeActor {
  householdId: string;
  userId: string;
  auditUserId?: string;
}

export const sessionUser = (a: ChangeActor): string => a.auditUserId ?? a.userId;

export function notFound(what: string): AppError {
  return new AppError("not_found", 404, `${what} not found.`);
}

export function invalid(path: string, message: string): AppError {
  return new AppError("validation_failed", 400, "The request has invalid fields.", {
    fields: [{ in: "body", path, message }],
  });
}

export async function todayFor(tx: Tx, deps: ChangeDeps, householdId: string): Promise<string> {
  const tz = await repo.householdTimezone(tx, householdId);
  if (!tz) throw notFound("Household");
  return householdToday(deps.now(), tz);
}

export function scheduleColumns(schedule: Item["schedule"]): Record<string, unknown> {
  try {
    const parts = scheduleToRRule(schedule);
    return { rrule: parts.rrule, dtstart: parts.dtstart, until: parts.until };
  } catch (err) {
    if (err instanceof EngineError) throw invalid("schedule", "That schedule is not valid.");
    throw err;
  }
}

export async function checkOwner(
  tx: Tx,
  householdId: string,
  ownerType: string,
  ownerUserId: string | null | undefined,
) {
  if (ownerType === "member" && ownerUserId && !(await repo.isMember(tx, householdId, ownerUserId))) {
    throw invalid("ownerUserId", "The owner must be a member of this household.");
  }
}

export const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  kind: "kind",
  category: "category",
  name: "name",
  providerName: "provider_name",
  providerDomain: "provider_domain",
  amountType: "amount_type",
  amountCents: "amount_cents",
  weekendRule: "weekend_rule",
  ownerType: "owner_type",
  ownerUserId: "owner_user_id",
  status: "status",
  accountLast4: "account_last4",
  paidFrom: "paid_from",
  markedPossiblyUnused: "marked_possibly_unused",
  subcategory: "subcategory",
  movable: "movable",
  onBillsPage: "on_bills_page",
  notes: "notes",
};

/** Which parts of a PATCH actually change something (a PATCH that repeats stored values is a no-op). */
export interface ItemEdits {
  owner: boolean;
  status: boolean;
  schedule: boolean;
  weekendRule: boolean;
}

export function itemEdits(current: Item, body: PatchItem): ItemEdits {
  const scheduleParts = body.schedule ? scheduleColumns(body.schedule) : null;
  const currentParts = scheduleColumns(current.schedule);
  return {
    owner:
      (body.ownerType !== undefined && body.ownerType !== current.ownerType) ||
      (body.ownerUserId !== undefined && body.ownerUserId !== current.ownerUserId),
    status: body.status !== undefined && body.status !== current.status,
    schedule:
      scheduleParts !== null &&
      (scheduleParts.rrule !== currentParts.rrule ||
        scheduleParts.dtstart !== currentParts.dtstart ||
        scheduleParts.until !== currentParts.until),
    weekendRule: body.weekendRule !== undefined && body.weekendRule !== current.weekendRule,
  };
}

/** Applies a PATCH to an item that is already locked and version-checked. */
export async function applyItemPatch(
  tx: Tx,
  deps: ChangeDeps,
  a: ChangeActor,
  current: Item,
  body: PatchItem,
): Promise<Item> {
  const id = current.id;
  const expected = current.version;
  const edits = itemEdits(current, body);
  const scheduleParts = body.schedule ? scheduleColumns(body.schedule) : null;

  const columns: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    const value = (body as Record<string, unknown>)[key];
    if (value !== undefined) columns[column] = value;
  }
  const ownerType = body.ownerType ?? current.ownerType;
  const ownerUserId = body.ownerUserId !== undefined ? body.ownerUserId : current.ownerUserId;
  if (body.ownerType !== undefined || body.ownerUserId !== undefined) {
    if ((ownerType === "member") !== (ownerUserId != null)) {
      throw invalid("ownerUserId", "A member owner needs ownerUserId; both and split must not have one.");
    }
    columns.owner_type = ownerType;
    columns.owner_user_id = ownerUserId ?? null;
    await checkOwner(tx, a.householdId, ownerType, ownerUserId);
  }
  const amountType = body.amountType ?? current.amountType;
  const amountCents = body.amountCents !== undefined ? body.amountCents : current.amountCents;
  // Q-107: no amount type may end up without an amount. Existing estimated items imported with only
  // history stay editable until their amount fields are touched.
  const amountTouched = body.amountType !== undefined || body.amountCents !== undefined;
  if ((amountType === "fixed" || amountTouched) && amountCents == null)
    throw invalid(
      "amountCents",
      "An item needs amountCents (the estimate or last statement for variable bills).",
    );

  if (scheduleParts) Object.assign(columns, scheduleParts);
  const scheduleChanged = edits.schedule || edits.weekendRule || edits.status;

  if (
    body.status !== undefined &&
    body.status !== "active" &&
    (await repo.isPrimaryIncome(tx, a.householdId, id))
  ) {
    throw new AppError("conflict", 409, "Choose another primary income before pausing or ending this one.");
  }
  if (!(await repo.updateItem(tx, id, expected, columns))) {
    const latest = await repo.getItem(tx, a.householdId, id);
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.", {
      current: latest,
    });
  }
  // Only schedule-affecting edits touch occurrences (future `scheduled` rows; paid ones stay).
  if (scheduleChanged) await rebuildFutureOccurrences(tx, id, await todayFor(tx, deps, a.householdId));
  await repo.audit(tx, a.householdId, sessionUser(a), "item.updated", "item", id);
  const item = await repo.getItem(tx, a.householdId, id);
  if (!item) throw notFound("Item");
  return item;
}

/** Soft-deletes a locked item and rebuilds its occurrences. */
export async function applyItemDelete(
  tx: Tx,
  deps: ChangeDeps,
  a: ChangeActor,
  current: Item,
): Promise<void> {
  if (await repo.isPrimaryIncome(tx, a.householdId, current.id)) {
    throw new AppError("conflict", 409, "Choose another primary income before deleting this one.");
  }
  await repo.softDeleteItem(tx, current.id);
  await rebuildFutureOccurrences(tx, current.id, await todayFor(tx, deps, a.householdId));
  await repo.audit(tx, a.householdId, sessionUser(a), "item.deleted", "item", current.id);
}

/** Applies a PATCH to an occurrence that is already locked and version-checked. */
export async function applyOccurrencePatch(
  tx: Tx,
  deps: ChangeDeps,
  a: ChangeActor,
  found: NonNullable<Awaited<ReturnType<typeof repo.getOccurrence>>>,
  body: PatchOccurrence,
): Promise<Occurrence> {
  const { occurrence, direction } = found;
  const id = occurrence.id;
  const expected = occurrence.version;
  const status = body.status ?? occurrence.status;
  if (body.status === "paid" && direction !== "outflow")
    throw invalid("status", "Only a bill can be marked as paid.");
  if (body.status === "received" && direction !== "inflow") {
    throw invalid("status", "Only income can be marked as received.");
  }
  if (body.dueOn !== undefined && status !== "scheduled") {
    throw invalid("dueOn", "Only an upcoming occurrence can be moved.");
  }
  if (body.paidOn !== undefined && status !== "paid" && status !== "received") {
    throw invalid("paidOn", "A paid date needs a paid or received status.");
  }

  const columns: Record<string, unknown> = {};
  if (body.status !== undefined && body.status !== occurrence.status) {
    columns.status = body.status;
    if (body.status === "paid" || body.status === "received") {
      columns.paid_on = body.paidOn ?? (await todayFor(tx, deps, a.householdId));
      columns.marked_by = a.userId;
    } else {
      columns.paid_on = null;
      columns.marked_by = body.status === "skipped" ? a.userId : null;
    }
  } else if (body.paidOn !== undefined) {
    columns.paid_on = body.paidOn;
  }
  if (body.dueOn !== undefined) {
    columns.due_on = body.dueOn;
    columns.moved_by = a.userId;
  }
  if (body.actualAmountCents !== undefined) columns.actual_amount_cents = body.actualAmountCents;

  // Repeating the stored values changes nothing: answer with the current occurrence.
  if (Object.keys(columns).length === 0) return occurrence;
  if (!(await repo.updateOccurrence(tx, id, expected, columns))) {
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
  }
  // An actual amount is also a data point for the item's estimate (rule 6) and may complete a task that
  // waits for it (BACKEND_PLAN §7.4).
  if (typeof body.actualAmountCents === "number") {
    await repo.upsertHistory(
      tx,
      a.householdId,
      occurrence.itemId,
      (columns.due_on as string | undefined) ?? occurrence.dueOn,
      body.actualAmountCents,
    );
    await autoCompleteTasks(
      tx,
      a.householdId,
      { type: "actual_amount_received", itemId: occurrence.itemId },
      sessionUser(a),
    );
  }
  await repo.audit(tx, a.householdId, sessionUser(a), "occurrence.updated", "occurrence", id);
  const updated = await repo.getOccurrence(tx, a.householdId, id);
  if (!updated) throw notFound("Occurrence");
  return updated.occurrence;
}

const PLANNED_MAP: Readonly<Record<string, string>> = {
  name: "name",
  amountCents: "amount_cents",
  dueOn: "due_on",
  ownerType: "owner_type",
  ownerUserId: "owner_user_id",
  goalId: "goal_id",
  status: "status",
};

/** Applies a PATCH to a planned expense that is already locked and version-checked. */
export async function applyPlannedPatch(
  tx: Tx,
  a: ChangeActor,
  current: PlannedExpense,
  body: Record<string, unknown>,
): Promise<PlannedExpense> {
  const columns: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(PLANNED_MAP)) if (body[k] !== undefined) columns[col] = body[k];
  const ownerType = (body.ownerType as string | undefined) ?? current.ownerType;
  const ownerUserId =
    body.ownerUserId !== undefined ? (body.ownerUserId as string | null) : current.ownerUserId;
  if ((ownerType === "member") !== (ownerUserId != null)) {
    throw invalid("ownerUserId", "A member owner needs ownerUserId; both and split must not have one.");
  }
  if (body.ownerType !== undefined || body.ownerUserId !== undefined) {
    columns.owner_type = ownerType;
    columns.owner_user_id = ownerUserId;
    await checkOwner(tx, a.householdId, ownerType, ownerUserId);
  }
  if (!(await repo.updatePlanned(tx, current.id, current.version, columns))) {
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
  }
  await repo.audit(
    tx,
    a.householdId,
    sessionUser(a),
    "planned_expense.updated",
    "planned_expense",
    current.id,
  );
  const updated = await repo.getPlanned(tx, a.householdId, current.id);
  if (!updated) throw notFound("Planned expense");
  return updated;
}

export async function applyPlannedDelete(tx: Tx, a: ChangeActor, current: PlannedExpense): Promise<void> {
  await repo.deletePlanned(tx, current.id);
  await repo.audit(
    tx,
    a.householdId,
    sessionUser(a),
    "planned_expense.deleted",
    "planned_expense",
    current.id,
  );
}
