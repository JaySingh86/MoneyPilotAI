// Business rules for items, renewals, occurrences, planned expenses and balances. Routes stay thin and
// SQL lives in repo.ts. Every function runs in one `withHouseholdTx` transaction, so a stale If-Match,
// a failed rebuild or a constraint error leaves nothing half written.
import {
  AppError,
  type Balance,
  type CreateItem,
  type Item,
  type Occurrence,
  type PatchItem,
  type PatchOccurrence,
  type PlannedExpense,
  type RenewalDetails,
} from "@mp/contracts";
import {
  extendOccurrences,
  householdToday,
  loadBillsAverages,
  rebuildFutureOccurrences,
  type ApiContext,
  type ApiDb,
  type Tx,
} from "@mp/db";
import { EngineError, scheduleToRRule } from "@mp/engine";
import { assertVersion } from "../../lib/if-match";
import * as repo from "./repo";

export interface ItemsDeps {
  db: ApiDb;
  /** UTC instant as ISO 8601. Calendar dates are derived with the household timezone. */
  now: () => string;
}

export interface Actor {
  ctx: ApiContext;
  userId: string;
  householdId: string;
}

function notFound(what: string): AppError {
  return new AppError("not_found", 404, `${what} not found.`);
}

/**
 * Interim guard until WP-13 ships proposals (BACKEND_PLAN §7.3, owner decision 2026-11-03): some changes to
 * the other member's item need their approval. A member's own items, and Both and Split items, stay directly
 * editable. Thrown as 403 `approval_required`.
 */
function approvalRequired(): AppError {
  return new AppError(
    "approval_required",
    403,
    "This item belongs to your partner. Ask them to approve the change.",
  );
}

function ownedByPartner(owner: { ownerType: string; ownerUserId: string | null }, userId: string): boolean {
  return owner.ownerType === "member" && owner.ownerUserId !== null && owner.ownerUserId !== userId;
}

function invalid(path: string, message: string): AppError {
  return new AppError("validation_failed", 400, "The request has invalid fields.", {
    fields: [{ in: "body", path, message }],
  });
}

/** Maps constraint failures that a client can cause to problem responses. */
export function mapDbError(err: unknown): never {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "42501") throw new AppError("forbidden", 403, "You do not have access to this household.");
    if (code === "23503") throw invalid("", "A referenced record does not exist in this household.");
    if (code === "23514") throw invalid("", "The values break a rule for this record.");
    if (code === "23505") throw new AppError("conflict", 409, "This record already exists.");
    current = (current as { cause?: unknown }).cause;
  }
  throw err;
}

async function inTx<T>(deps: ItemsDeps, a: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

async function todayFor(tx: Tx, deps: ItemsDeps, householdId: string): Promise<string> {
  const tz = await repo.householdTimezone(tx, householdId);
  if (!tz) throw notFound("Household");
  return householdToday(deps.now(), tz);
}

function scheduleColumns(schedule: Item["schedule"]): Record<string, unknown> {
  try {
    const parts = scheduleToRRule(schedule);
    return { rrule: parts.rrule, dtstart: parts.dtstart, until: parts.until };
  } catch (err) {
    if (err instanceof EngineError) throw invalid("schedule", "That schedule is not valid.");
    throw err;
  }
}

async function checkOwner(tx: Tx, a: Actor, ownerType: string, ownerUserId: string | null | undefined) {
  if (ownerType === "member" && ownerUserId && !(await repo.isMember(tx, a.householdId, ownerUserId))) {
    throw invalid("ownerUserId", "The owner must be a member of this household.");
  }
}

// ===== Items =====
export async function listItems(
  deps: ItemsDeps,
  a: Actor,
  filter: repo.ItemFilter,
  limit: number,
  include?: "averages",
) {
  return inTx(deps, a, async (tx) => {
    const rows = await repo.listItems(tx, a.householdId, filter, limit + 1);
    const data = rows.slice(0, limit);
    const page = { data, nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null };
    if (include !== "averages") return page;
    // Same transaction, so the averages describe exactly the rows the page was read from (WP-12).
    const averages = await loadBillsAverages(tx, a.householdId, deps.now());
    return averages ? { ...page, averages } : page;
  });
}

export async function getItem(deps: ItemsDeps, a: Actor, id: string): Promise<Item> {
  return inTx(deps, a, async (tx) => {
    const item = await repo.getItem(tx, a.householdId, id);
    if (!item) throw notFound("Item");
    return item;
  });
}

export async function createItem(deps: ItemsDeps, a: Actor, body: CreateItem): Promise<Item> {
  return inTx(deps, a, async (tx) => {
    await checkOwner(tx, a, body.ownerType, body.ownerUserId);
    const id = await repo.insertItem(tx, a.householdId, a.userId, {
      direction: body.direction,
      kind: body.kind,
      category: body.category,
      name: body.name,
      provider_name: body.providerName ?? null,
      provider_domain: body.providerDomain ?? null,
      amount_type: body.amountType,
      amount_cents: body.amountCents ?? null,
      ...scheduleColumns(body.schedule),
      weekend_rule: body.weekendRule,
      owner_type: body.ownerType,
      owner_user_id: body.ownerUserId ?? null,
      status: body.status,
      source: "manual",
      account_last4: body.accountLast4 ?? null,
      paid_from: body.paidFrom,
      marked_possibly_unused: body.markedPossiblyUnused,
      subcategory: body.subcategory ?? null,
      movable: body.movable ?? null,
      on_bills_page: body.onBillsPage,
      notes: body.notes ?? null,
    });
    await extendOccurrences(tx, id, await todayFor(tx, deps, a.householdId));
    await repo.audit(tx, a.householdId, a.userId, "item.created", "item", id);
    const item = await repo.getItem(tx, a.householdId, id);
    if (!item) throw new Error("created item is not readable");
    return item;
  });
}

const PATCH_COLUMNS: Readonly<Record<string, string>> = {
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

export async function patchItem(
  deps: ItemsDeps,
  a: Actor,
  id: string,
  expected: number,
  body: PatchItem,
): Promise<Item> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    assertVersion(expected, current);
    // What actually changes (a PATCH that repeats the stored values is a no-op and needs no approval).
    const scheduleParts = body.schedule ? scheduleColumns(body.schedule) : null;
    const currentParts = scheduleColumns(current.schedule);
    const scheduleEdited =
      scheduleParts !== null &&
      (scheduleParts.rrule !== currentParts.rrule ||
        scheduleParts.dtstart !== currentParts.dtstart ||
        scheduleParts.until !== currentParts.until);
    const weekendEdited = body.weekendRule !== undefined && body.weekendRule !== current.weekendRule;
    const statusEdited = body.status !== undefined && body.status !== current.status;
    const ownerEdited =
      (body.ownerType !== undefined && body.ownerType !== current.ownerType) ||
      (body.ownerUserId !== undefined && body.ownerUserId !== current.ownerUserId);
    // Schedule and weekend rule move every future due date, so they need approval like a status or owner change.
    if (
      ownedByPartner(current, a.userId) &&
      (ownerEdited || statusEdited || scheduleEdited || weekendEdited)
    ) {
      throw approvalRequired();
    }

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
      await checkOwner(tx, a, ownerType, ownerUserId);
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
    const scheduleChanged = scheduleEdited || weekendEdited || statusEdited;

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
    await repo.audit(tx, a.householdId, a.userId, "item.updated", "item", id);
    const item = await repo.getItem(tx, a.householdId, id);
    if (!item) throw notFound("Item");
    return item;
  });
}

export async function deleteItem(deps: ItemsDeps, a: Actor, id: string): Promise<void> {
  await inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    if (ownedByPartner(current, a.userId)) throw approvalRequired();
    if (await repo.isPrimaryIncome(tx, a.householdId, id)) {
      throw new AppError("conflict", 409, "Choose another primary income before deleting this one.");
    }
    await repo.softDeleteItem(tx, id);
    await rebuildFutureOccurrences(tx, id, await todayFor(tx, deps, a.householdId));
    await repo.audit(tx, a.householdId, a.userId, "item.deleted", "item", id);
  });
}

export async function putRenewal(
  deps: ItemsDeps,
  a: Actor,
  id: string,
  body: Partial<RenewalDetails>,
): Promise<Item> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    await repo.putRenewal(tx, a.householdId, id, {
      autoRenews: body.autoRenews ?? "yes",
      coverageStart: body.coverageStart ?? null,
      coverageEnd: body.coverageEnd ?? null,
      cancelBy: body.cancelBy ?? null,
      decisionBy: body.decisionBy ?? null,
      shopAroundOn: body.shopAroundOn ?? null,
      previousAmountCents: body.previousAmountCents ?? null,
      priceChangedOn: body.priceChangedOn ?? null,
    });
    await repo.audit(tx, a.householdId, a.userId, "item.renewal_updated", "item", id);
    const item = await repo.getItem(tx, a.householdId, id);
    if (!item) throw notFound("Item");
    return item;
  });
}

export async function itemHistory(deps: ItemsDeps, a: Actor, id: string) {
  return inTx(deps, a, async (tx) => {
    if (!(await repo.getItem(tx, a.householdId, id))) throw notFound("Item");
    return { data: await repo.listHistory(tx, id) };
  });
}

// ===== Occurrences =====
export async function listOccurrences(deps: ItemsDeps, a: Actor, from: string, to: string, itemId?: string) {
  return inTx(deps, a, async (tx) => ({
    data: await repo.listOccurrences(tx, a.householdId, from, to, itemId),
  }));
}

export async function patchOccurrence(
  deps: ItemsDeps,
  a: Actor,
  id: string,
  expected: number,
  body: PatchOccurrence,
): Promise<Occurrence> {
  return inTx(deps, a, async (tx) => {
    const found = await repo.getOccurrence(tx, a.householdId, id);
    if (!found) throw notFound("Occurrence");
    const { occurrence, direction } = found;
    assertVersion(expected, occurrence);
    // Moving a due date or skipping an occurrence of the partner's item needs their approval; paying is fine.
    if (
      ownedByPartner(found, a.userId) &&
      (body.dueOn !== undefined || (body.status === "skipped" && occurrence.status !== "skipped"))
    ) {
      throw approvalRequired();
    }

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
    // An actual amount is also a data point for the item's estimate (rule 6).
    if (typeof body.actualAmountCents === "number") {
      await repo.upsertHistory(
        tx,
        a.householdId,
        occurrence.itemId,
        (columns.due_on as string | undefined) ?? occurrence.dueOn,
        body.actualAmountCents,
      );
    }
    await repo.audit(tx, a.householdId, a.userId, "occurrence.updated", "occurrence", id);
    const updated = await repo.getOccurrence(tx, a.householdId, id);
    if (!updated) throw notFound("Occurrence");
    return updated.occurrence;
  });
}

// ===== Planned expenses =====
export async function listPlanned(deps: ItemsDeps, a: Actor, status?: string) {
  return inTx(deps, a, async (tx) => ({ data: await repo.listPlanned(tx, a.householdId, status) }));
}

export async function createPlanned(
  deps: ItemsDeps,
  a: Actor,
  body: {
    name: string;
    amountCents: number;
    dueOn: string;
    ownerType: string;
    ownerUserId?: string | null | undefined;
    goalId?: string | null | undefined;
    status: string;
  },
): Promise<PlannedExpense> {
  return inTx(deps, a, async (tx) => {
    await checkOwner(tx, a, body.ownerType, body.ownerUserId);
    const id = await repo.insertPlanned(tx, a.householdId, a.userId, {
      ...body,
      ownerUserId: body.ownerUserId ?? null,
      goalId: body.goalId ?? null,
    });
    await repo.audit(tx, a.householdId, a.userId, "planned_expense.created", "planned_expense", id);
    const created = await repo.getPlanned(tx, a.householdId, id);
    if (!created) throw notFound("Planned expense");
    return created;
  });
}

export async function patchPlanned(
  deps: ItemsDeps,
  a: Actor,
  id: string,
  expected: number,
  body: Record<string, unknown>,
): Promise<PlannedExpense> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getPlanned(tx, a.householdId, id);
    if (!current) throw notFound("Planned expense");
    assertVersion(expected, current);
    // Interim guard (see approvalRequired): the partner's planned expense can't be re-owned or re-dated.
    if (
      ownedByPartner(current, a.userId) &&
      ((body.ownerType !== undefined && body.ownerType !== current.ownerType) ||
        (body.ownerUserId !== undefined && body.ownerUserId !== current.ownerUserId) ||
        (body.dueOn !== undefined && body.dueOn !== current.dueOn))
    ) {
      throw approvalRequired();
    }
    const map: Record<string, string> = {
      name: "name",
      amountCents: "amount_cents",
      dueOn: "due_on",
      ownerType: "owner_type",
      ownerUserId: "owner_user_id",
      goalId: "goal_id",
      status: "status",
    };
    const columns: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(map)) if (body[k] !== undefined) columns[col] = body[k];
    const ownerType = (body.ownerType as string | undefined) ?? current.ownerType;
    const ownerUserId =
      body.ownerUserId !== undefined ? (body.ownerUserId as string | null) : current.ownerUserId;
    if ((ownerType === "member") !== (ownerUserId != null)) {
      throw invalid("ownerUserId", "A member owner needs ownerUserId; both and split must not have one.");
    }
    if (body.ownerType !== undefined || body.ownerUserId !== undefined) {
      columns.owner_type = ownerType;
      columns.owner_user_id = ownerUserId;
      await checkOwner(tx, a, ownerType, ownerUserId);
    }
    if (!(await repo.updatePlanned(tx, id, expected, columns))) {
      throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
    }
    await repo.audit(tx, a.householdId, a.userId, "planned_expense.updated", "planned_expense", id);
    const updated = await repo.getPlanned(tx, a.householdId, id);
    if (!updated) throw notFound("Planned expense");
    return updated;
  });
}

export async function deletePlanned(deps: ItemsDeps, a: Actor, id: string): Promise<void> {
  await inTx(deps, a, async (tx) => {
    const current = await repo.getPlanned(tx, a.householdId, id);
    if (!current) throw notFound("Planned expense");
    if (ownedByPartner(current, a.userId)) throw approvalRequired();
    await repo.deletePlanned(tx, id);
    await repo.audit(tx, a.householdId, a.userId, "planned_expense.deleted", "planned_expense", id);
  });
}

// ===== Balances =====
export async function createBalance(
  deps: ItemsDeps,
  a: Actor,
  body: { label: string; amountCents: number; asOf: string },
): Promise<Balance> {
  return inTx(deps, a, async (tx) => {
    const balance = await repo.insertBalance(tx, a.householdId, a.userId, body);
    await repo.audit(tx, a.householdId, a.userId, "balance.recorded", "balance", balance.id);
    return balance;
  });
}

export async function latestBalance(deps: ItemsDeps, a: Actor): Promise<Balance> {
  return inTx(deps, a, async (tx) => {
    const balance = await repo.latestBalance(tx, a.householdId);
    if (!balance) throw notFound("Balance");
    return balance;
  });
}
