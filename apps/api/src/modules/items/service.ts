// Business rules for items, renewals, occurrences, planned expenses and balances. Routes stay thin and
// SQL lives in repo.ts. Every function runs in one `withHouseholdTx` transaction, so a stale If-Match,
// a failed rebuild or a constraint error leaves nothing half written.
//
// Changes to the other member's item that move the shared plan (BACKEND_PLAN §7.3) do not apply: they
// become a proposal the other member approves (`requiresApproval`, packages/contracts). The caller answers
// 202 with the proposal. A member's own items, and Both and Split items, stay directly editable.
import {
  AppError,
  requiresApproval,
  type Balance,
  type CreateItem,
  type Item,
  type Occurrence,
  type PatchItem,
  type PatchOccurrence,
  type PlannedExpense,
  type ProposalPayload,
  type RenewalDetails,
} from "@mp/contracts";
import { extendOccurrences, loadBillsAverages, type ApiContext, type ApiDb, type Tx } from "@mp/db";
import { assertVersion } from "../../lib/if-match";
import { insertProposal, type Gated } from "../proposals/core";
import {
  applyItemDelete,
  applyItemPatch,
  applyOccurrencePatch,
  applyPlannedDelete,
  applyPlannedPatch,
  checkOwner,
  invalid,
  itemEdits,
  notFound,
  scheduleColumns,
  todayFor,
  type ChangeDeps,
} from "./changes";
import * as repo from "./repo";

export interface ItemsDeps extends ChangeDeps {
  db: ApiDb;
}

export interface Actor {
  ctx: ApiContext;
  userId: string;
  householdId: string;
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

/**
 * The queued review item an item is being created from (WP-14, Q-124). The server reads `source` from the
 * extracted item itself; a client never names a source. The database re-checks it (policy
 * `recurring_items_api_insert_review`: same household, still queued, same source).
 */
export interface CreatedFromReview {
  reviewItemId: string;
  source: "email" | "csv";
}

export async function createItem(
  deps: ItemsDeps,
  a: Actor,
  body: CreateItem,
  fromReview?: CreatedFromReview,
): Promise<Item> {
  return inTx(deps, a, async (tx) => {
    await checkOwner(tx, a.householdId, body.ownerType, body.ownerUserId);
    if (fromReview) await repo.allowReviewInsert(tx, fromReview.reviewItemId);
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
      source: fromReview?.source ?? "manual",
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

/** The stored values of the fields a change touches, compared again when a proposal is approved. */
/**
 * Undoing an applied review change (WP-14) removes renewal details or an amount-history point of the other
 * member's item. That is one all-or-nothing transaction, so it can't become a proposal (the proposal would be
 * rolled back with the failed undo, and a deferred half-undo would leave the item inconsistent). It stays
 * blocked: 403 `approval_required`. The owner can undo their own items.
 */
function approvalRequired(): AppError {
  return new AppError(
    "approval_required",
    403,
    "This item belongs to your partner. Ask them to undo this change.",
  );
}

function isPartners(owner: { ownerType: string; ownerUserId: string | null }, userId: string): boolean {
  return owner.ownerType === "member" && owner.ownerUserId !== null && owner.ownerUserId !== userId;
}

function snapshot(current: object, changes: object): Record<string, unknown> {
  const now = current as Record<string, unknown>;
  return Object.fromEntries(Object.keys(changes).map((k) => [k, now[k] ?? null]));
}

async function propose(tx: Tx, deps: ItemsDeps, a: Actor, payload: ProposalPayload) {
  return insertProposal(tx, {
    householdId: a.householdId,
    proposedBy: a.userId,
    payload,
    nowIso: deps.now(),
  });
}

export async function patchItem(
  deps: ItemsDeps,
  a: Actor,
  id: string,
  expected: number,
  body: PatchItem,
): Promise<Gated<Item>> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    assertVersion(expected, current);
    // Schedule and weekend rule move every future due date, so they need approval like a status or owner
    // change. A PATCH that repeats the stored values is a no-op and needs none.
    const edits = itemEdits(current, body);
    const owner = { ownerType: current.ownerType, ownerUserId: current.ownerUserId };
    const needsApproval =
      (edits.owner && requiresApproval({ type: "item_owner", ...owner }, a.userId)) ||
      (edits.status && requiresApproval({ type: "item_status", ...owner }, a.userId)) ||
      ((edits.schedule || edits.weekendRule) &&
        requiresApproval({ type: "item_schedule", ...owner }, a.userId));
    if (needsApproval) {
      return {
        proposal: await propose(tx, deps, a, {
          type: "item_patch",
          itemId: id,
          itemName: current.name,
          ownerUserId: current.ownerUserId,
          changes: body,
          before: snapshot(current, body),
        }),
      };
    }
    return { applied: await applyItemPatch(tx, deps, a, current, body) };
  });
}

export async function deleteItem(deps: ItemsDeps, a: Actor, id: string): Promise<Gated<null>> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    const owner = { ownerType: current.ownerType, ownerUserId: current.ownerUserId };
    if (requiresApproval({ type: "item_delete", ...owner }, a.userId)) {
      return {
        proposal: await propose(tx, deps, a, {
          type: "item_delete",
          itemId: id,
          itemName: current.name,
          ownerUserId: current.ownerUserId,
        }),
      };
    }
    await applyItemDelete(tx, deps, a, current);
    return { applied: null };
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

/**
 * Removes the renewal details of an item (WP-14 undo, Q-122). Guarded like other writes to the partner's item:
 * the other member's item needs their approval.
 */
export async function deleteRenewal(deps: ItemsDeps, a: Actor, id: string): Promise<void> {
  await inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    if (isPartners(current, a.userId)) throw approvalRequired();
    await repo.deleteRenewal(tx, id);
    await repo.audit(tx, a.householdId, a.userId, "item.renewal_deleted", "item", id);
  });
}

/** Removes the hand-entered amount-history point of a date (WP-14 undo of an actual amount, Q-122). */
export async function deleteHistoryPoint(
  deps: ItemsDeps,
  a: Actor,
  id: string,
  occurredOn: string,
): Promise<void> {
  await inTx(deps, a, async (tx) => {
    const current = await repo.getItem(tx, a.householdId, id, true);
    if (!current) throw notFound("Item");
    if (isPartners(current, a.userId)) throw approvalRequired();
    await repo.deleteHistoryPoint(tx, id, occurredOn);
    await repo.audit(tx, a.householdId, a.userId, "item.history_point_deleted", "item", id);
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
): Promise<Gated<Occurrence>> {
  return inTx(deps, a, async (tx) => {
    const found = await repo.getOccurrence(tx, a.householdId, id);
    if (!found) throw notFound("Occurrence");
    const { occurrence } = found;
    assertVersion(expected, occurrence);
    // Moving a due date or skipping an occurrence of the partner's item needs their approval; paying is fine.
    const moving = body.dueOn !== undefined && body.dueOn !== occurrence.dueOn;
    const skipping = body.status === "skipped" && occurrence.status !== "skipped";
    const owner = { ownerType: found.ownerType, ownerUserId: found.ownerUserId };
    const gate =
      (moving && requiresApproval({ type: "occurrence_move", ...owner }, a.userId)) ||
      (skipping && requiresApproval({ type: "occurrence_skip", ...owner }, a.userId));
    if (gate) {
      // The proposal carries one change; anything sent beside it would be dropped silently.
      const extra = Object.keys(body).filter((k) => k !== (moving ? "dueOn" : "status"));
      if (extra.length > 0) {
        throw invalid(extra[0] ?? "", "A change that needs approval must be sent on its own.");
      }
      const item = await repo.getItem(tx, a.householdId, occurrence.itemId);
      if (!item) throw notFound("Item");
      const base = { occurrenceId: id, itemId: item.id, itemName: item.name, ownerUserId: item.ownerUserId };
      return {
        proposal: await propose(
          tx,
          deps,
          a,
          moving && body.dueOn !== undefined
            ? { type: "occurrence_move", ...base, fromDueOn: occurrence.dueOn, toDueOn: body.dueOn }
            : { type: "occurrence_skip", ...base, dueOn: occurrence.dueOn },
        ),
      };
    }
    // A date repeated unchanged is not a move: leave `moved_by` alone.
    const { dueOn: _same, ...rest } = body;
    return { applied: await applyOccurrencePatch(tx, deps, a, found, moving ? body : rest) };
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
    await checkOwner(tx, a.householdId, body.ownerType, body.ownerUserId);
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
): Promise<Gated<PlannedExpense>> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getPlanned(tx, a.householdId, id);
    if (!current) throw notFound("Planned expense");
    assertVersion(expected, current);
    // The partner's planned expense can't be re-owned or re-dated without their approval.
    const owner = { ownerType: current.ownerType, ownerUserId: current.ownerUserId };
    const ownerEdited =
      (body.ownerType !== undefined && body.ownerType !== current.ownerType) ||
      (body.ownerUserId !== undefined && body.ownerUserId !== current.ownerUserId);
    const moved = body.dueOn !== undefined && body.dueOn !== current.dueOn;
    if (
      (ownerEdited && requiresApproval({ type: "planned_owner", ...owner }, a.userId)) ||
      (moved && requiresApproval({ type: "planned_move", ...owner }, a.userId))
    ) {
      return {
        proposal: await propose(tx, deps, a, {
          type: "planned_patch",
          plannedExpenseId: id,
          name: current.name,
          ownerUserId: current.ownerUserId,
          changes: body,
          before: snapshot(current, body),
        }),
      };
    }
    return { applied: await applyPlannedPatch(tx, a, current, body) };
  });
}

export async function deletePlanned(deps: ItemsDeps, a: Actor, id: string): Promise<Gated<null>> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getPlanned(tx, a.householdId, id);
    if (!current) throw notFound("Planned expense");
    const owner = { ownerType: current.ownerType, ownerUserId: current.ownerUserId };
    if (requiresApproval({ type: "planned_delete", ...owner }, a.userId)) {
      return {
        proposal: await propose(tx, deps, a, {
          type: "planned_delete",
          plannedExpenseId: id,
          name: current.name,
          ownerUserId: current.ownerUserId,
        }),
      };
    }
    await applyPlannedDelete(tx, a, current);
    return { applied: null };
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
