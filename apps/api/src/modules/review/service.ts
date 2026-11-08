// Review queue + applied changes (BACKEND_PLAN §7.8.2, §8.2, §8.3).
//
// Every decision runs in ONE `withHouseholdTx` transaction: the item edits, the `applied_changes` row, the state
// change and the audit event commit together or not at all. Item edits go through the WP-06 items service (the
// same ownership/approval guard, version checks and occurrence rebuilds as the Bills screens) by handing it a
// database handle bound to this transaction; there is no SQL against items in this module. Which edits a change
// makes is planned by the pure `@mp/review-rules` package, which the worker shares.
import { z } from "zod";
import {
  AppError,
  Cents,
  EvidenceQuote,
  ExtractedFields,
  IsoDate,
  RenewalDetails,
  ReviewMessage,
  Uuid,
  type AppliedChange,
  type AutomationStats,
  type EditReviewItem,
  type Item,
  type PutSenderRule,
  type ReviewDecision,
  type ReviewItem,
  type ReviewState,
  type SenderRule,
} from "@mp/contracts";
import { loadEngineInput, type ApiContext, type ApiDb, type Tx } from "@mp/db";
import { computeFullPlan } from "@mp/engine";
import { itemFromFields, planUpdate, snapshotMatches } from "@mp/review-rules";
import * as items from "../items/service";
import { maskSubject } from "./mask";
import * as repo from "./repo";

export interface ReviewDeps {
  db: ApiDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

export interface Actor {
  ctx: ApiContext;
  userId: string;
  householdId: string;
}

const notFound = (what: string) => new AppError("not_found", 404, `${what} not found.`);
const conflict = (detail: string) => new AppError("conflict", 409, detail);
const unreadable = () =>
  conflict("This item cannot be read any more. Ignore it; a new message will bring it back if it matters.");

/** The items service opens its own transaction per call; this handle makes it join the one we are in. */
function itemsIn(tx: Tx, deps: ReviewDeps): items.ItemsDeps {
  const joined: ApiDb = {
    withHouseholdTx: (_ctx, fn) => fn(tx),
    close: async () => undefined,
  };
  return { db: joined, now: deps.now };
}

async function inTx<T>(deps: ReviewDeps, a: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return items.mapDbError(err);
  }
}

// ===== Mapping =====
function summaryFor(row: repo.ReviewRow, fields: ExtractedFields): string {
  const name = row.matchItemName ?? fields.providerName ?? "this item";
  switch (row.matchType) {
    case "new":
      return `Adds ${fields.providerName ?? "a new item"} to your plan.`;
    case "update": {
      const changed =
        fields.amountDueCents !== null &&
        fields.previousAmountCents !== null &&
        fields.amountDueCents !== fields.previousAmountCents;
      return changed ? `Updates ${name} and flags a price change.` : `Updates ${name}.`;
    }
    case "decision":
      return `Updates the decision dates for ${name}.`;
    case "duplicate":
      return `Matches ${name}, which you already have. Nothing changes.`;
  }
}

const BLANK_FIELDS: ExtractedFields = {
  docType: "irrelevant",
  providerName: null,
  category: null,
  insuranceType: null,
  amountDueCents: null,
  previousAmountCents: null,
  dueDate: null,
  renewalDate: null,
  cancelByDate: null,
  decisionByDate: null,
  frequency: null,
  autoRenews: null,
  accountLast4: null,
  providerDomain: null,
};

/**
 * A stored row that no longer parses (a worker bug, an old shape) is skipped in lists instead of failing them
 * (L5): the contract is that the worker writes every key, so a bad row is a defect to fix, not a 500 for the user.
 */
function toReviewItem(row: repo.ReviewRow, lenient = false): ReviewItem | null {
  let fields = ExtractedFields.safeParse(row.fields);
  let evidence = EvidenceQuote.array().safeParse(row.evidence);
  if (lenient && (!fields.success || !evidence.success)) {
    // Only used to answer "ignore" for a row that cannot be read: an empty card, so the item can be dismissed.
    fields = ExtractedFields.safeParse(BLANK_FIELDS);
    evidence = EvidenceQuote.array().safeParse([]);
  }
  if (!fields.success || !evidence.success) return null;
  const message = ReviewMessage.safeParse(row.messageMeta);
  return {
    id: row.id,
    source: row.source,
    state: row.state,
    matchType: row.matchType,
    matchItemId: row.matchItemId,
    // The subject is masked again on the way out (M1): digit runs of 8+ and card patterns.
    message: message.success ? { ...message.data, subject: maskSubject(message.data.subject) } : null,
    fields: fields.data,
    evidence: evidence.data,
    evidenceStale: row.evidenceStale,
    // The plan delta needs a plan read (`loadEngineInput` / `recomputePlan` in @mp/db, WP-12) and must come from
    // the engine, never from this service. The decision response carries a fresh `plan` (see `freshPlan`); the
    // per-card delta stays null (Q-121, accepted).
    effect: { summary: summaryFor(row, fields.data), planDelta: null },
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    appliedChangeId: row.appliedChangeId,
    createdAt: row.createdAt,
  };
}

function toApplied(row: repo.AppliedRow): AppliedChange {
  return {
    id: row.id,
    origin: row.origin as AppliedChange["origin"],
    entityType: row.entityType,
    entityId: row.entityId,
    entityName: row.entityName,
    before: row.before,
    after: row.after,
    appliedBy: row.appliedBy,
    appliedAt: row.appliedAt,
    undoUntil: row.undoUntil,
    undoneAt: row.undoneAt,
    undoneBy: row.undoneBy,
    undoable: row.undoable,
  };
}

function parseCursor(cursor: string | undefined): repo.PageCursor | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  const ok =
    typeof at === "string" &&
    typeof id === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!ok) {
    throw new AppError("validation_failed", 400, "The cursor is not valid.", {
      fields: [{ in: "querystring", path: "cursor", message: "Use the cursor from the previous page" }],
    });
  }
  return { at, id };
}

// ===== Queue =====
export async function listReview(
  deps: ReviewDeps,
  a: Actor,
  state: ReviewState,
  limit: number,
  cursor?: string,
) {
  const after = parseCursor(cursor);
  return inTx(deps, a, async (tx) => {
    const rows = await repo.listReview(tx, a.householdId, state, after, limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.flatMap((row) => toReviewItem(row) ?? []),
      nextCursor: rows.length > limit && last ? `${last.sortCursor}|${last.id}` : null,
    };
  });
}

export async function getReview(deps: ReviewDeps, a: Actor, id: string): Promise<ReviewItem> {
  return inTx(deps, a, async (tx) => {
    const row = await repo.getReview(tx, a.householdId, id);
    if (!row) throw notFound("Review item");
    const item = toReviewItem(row);
    if (!item) throw unreadable();
    return item;
  });
}

// ===== Apply =====
/** What a change wrote or replaced, kept in `applied_changes.before/after` so it can be restored. Parsed on read. */
const Snapshot = z.strictObject({
  amountCents: Cents.nullable().optional(),
  renewal: RenewalDetails.nullable().optional(),
  occurrence: z.strictObject({ id: Uuid, dueDate: IsoDate, actualAmountCents: Cents.nullable() }).optional(),
  created: z.literal(true).optional(),
  itemId: Uuid.optional(),
  name: z.string().optional(),
  version: z.number().int().optional(),
});
type Snapshot = z.infer<typeof Snapshot>;

interface Applied {
  entityId: string;
  before: Snapshot | null;
  after: Snapshot;
}

function invalid(path: string, message: string): AppError {
  return new AppError("validation_failed", 400, "The request has invalid fields.", {
    fields: [{ in: "body", path, message }],
  });
}

/** Applies the (possibly edited) fields through the items service. Returns null when nothing changes. */
async function applyFields(
  tx: Tx,
  deps: ReviewDeps,
  a: Actor,
  row: repo.ReviewRow,
  fields: ExtractedFields,
): Promise<Applied | null> {
  const d = itemsIn(tx, deps);

  if (row.matchType === "duplicate") return null;

  if (row.matchType === "new") {
    const built = itemFromFields(fields, { ownerUserId: a.userId });
    if (!built.ok) throw invalid(`fields.${built.field}`, built.message);
    // The source comes from the extracted item, never from the client (Q-124).
    const created = await items.createItem(d, a, built.item, { reviewItemId: row.id, source: row.source });
    let renewal: RenewalDetails | null = null;
    if (built.renewal) renewal = (await items.putRenewal(d, a, created.id, built.renewal)).renewal;
    return {
      entityId: created.id,
      before: null,
      after: {
        created: true,
        itemId: created.id,
        name: created.name,
        amountCents: created.amountCents,
        renewal,
        version: created.version,
      },
    };
  }

  // update | decision: needs the matched item.
  if (row.matchItemId === null) throw conflict("This item no longer matches anything in your plan.");
  const item: Item | null = await items.getItem(d, a, row.matchItemId).catch((err: unknown) => {
    if (err instanceof AppError && err.status === 404) return null;
    throw err;
  });
  if (!item) throw conflict("The matching item was removed.");
  const plan = planUpdate(row.matchType, fields, item);
  const before: Snapshot = {};
  const after: Snapshot = {};

  if (row.matchType === "update" && item.amountType === "estimated" && fields.amountDueCents !== null) {
    // An estimated item records the actual on its bill for that date. No bill, no confirm (L2).
    if (!plan.occurrenceActual)
      throw invalid("fields.dueDate", "A due date is needed to record this amount.");
    const { dueDate, amountCents } = plan.occurrenceActual;
    const day = await items.listOccurrences(d, a, dueDate, dueDate, item.id);
    const occ = day.data.find((o) => o.dueOn === dueDate && o.status === "scheduled");
    if (!occ) throw conflict("There is no upcoming bill for this item on that date.");
    if (occ.actualAmountCents !== amountCents) {
      await items.patchOccurrence(d, a, occ.id, occ.version, { actualAmountCents: amountCents });
      before.occurrence = { id: occ.id, dueDate, actualAmountCents: occ.actualAmountCents };
      after.occurrence = { id: occ.id, dueDate, actualAmountCents: amountCents };
    }
  }
  if (plan.amountCents !== null) {
    await items.patchItem(d, a, item.id, item.version, { amountCents: plan.amountCents });
    before.amountCents = item.amountCents;
    after.amountCents = plan.amountCents;
  }
  if (plan.renewal) {
    await items.putRenewal(d, a, item.id, plan.renewal);
    before.renewal = item.renewal;
    after.renewal = plan.renewal;
  }
  if (Object.keys(after).length === 0) return null;
  return { entityId: item.id, before, after };
}

async function decideItem(
  deps: ReviewDeps,
  a: Actor,
  id: string,
  mode: "confirmed" | "edited" | "ignored",
  edit?: EditReviewItem,
): Promise<ReviewDecision> {
  return inTx(deps, a, async (tx) => {
    const row = await repo.getReview(tx, a.householdId, id, true);
    if (!row) throw notFound("Review item");
    if (row.state !== "queued") throw conflict("This item was already decided.");
    const now = deps.now();

    let fields: ExtractedFields | null = null;
    if (mode !== "ignored") {
      // Ignoring must always work, even for a row that no longer parses (L5).
      const parsed = ExtractedFields.safeParse(row.fields);
      if (!parsed.success) throw unreadable();
      fields = parsed.data;
      if (edit) {
        const merged = ExtractedFields.safeParse({ ...fields, ...edit.fields });
        if (!merged.success) throw invalid("fields", "The corrected values are not valid.");
        fields = merged.data;
      }
    }

    let appliedChangeId: string | null = null;
    if (fields) {
      const applied = await applyFields(tx, deps, a, row, fields);
      if (applied) {
        appliedChangeId = await repo.insertApplied(tx, a.householdId, {
          origin: row.source,
          entityType: "item",
          entityId: applied.entityId,
          before: applied.before,
          after: applied.after,
          appliedBy: a.userId,
          appliedAt: now,
        });
      }
    }
    const moved = await repo.decide(tx, id, {
      state: mode,
      decidedBy: a.userId,
      decidedAt: now,
      appliedChangeId,
      ...(edit && fields ? { fields } : {}),
    });
    if (!moved) throw conflict("This item was already decided.");
    await repo.audit(tx, a.householdId, a.userId, `review.${mode}`, "extracted_item", id);

    const updated = await repo.getReview(tx, a.householdId, id);
    const item = updated ? toReviewItem(updated, mode === "ignored") : null;
    if (!item) throw notFound("Review item");
    const change = appliedChangeId ? await repo.getApplied(tx, a.householdId, appliedChangeId, now) : null;
    return { item, appliedChange: change ? toApplied(change) : null, plan: await freshPlan(tx, deps, a) };
  });
}

/**
 * Safe to spend after the decision, read from the engine inside the same transaction (so it includes the change
 * just made). The review service never computes an amount itself (hard rule 4); null before onboarding is done.
 */
async function freshPlan(tx: Tx, deps: ReviewDeps, a: Actor): Promise<ReviewDecision["plan"]> {
  const loaded = await loadEngineInput(tx, a.householdId, { nowIso: deps.now() });
  if (!loaded || !loaded.ready) return null;
  return { safeToSpendCents: computeFullPlan(loaded.input).safeToSpendCents };
}

export const confirm = (deps: ReviewDeps, a: Actor, id: string) => decideItem(deps, a, id, "confirmed");
export const edit = (deps: ReviewDeps, a: Actor, id: string, body: EditReviewItem) =>
  decideItem(deps, a, id, "edited", body);
export const ignore = (deps: ReviewDeps, a: Actor, id: string) => decideItem(deps, a, id, "ignored");

// ===== Applied changes =====
export async function listApplied(deps: ReviewDeps, a: Actor, limit: number, cursor?: string) {
  const after = parseCursor(cursor);
  return inTx(deps, a, async (tx) => {
    const rows = await repo.listApplied(tx, a.householdId, deps.now(), after, limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toApplied),
      nextCursor: rows.length > limit && last ? `${last.appliedCursor}|${last.id}` : null,
    };
  });
}

const gone = (): AppError => conflict("The item was removed or changed since, so this cannot be undone.");

/** The values of the keys `after` wrote, as they are now. */
async function currentSnapshot(
  d: items.ItemsDeps,
  a: Actor,
  itemId: string,
  after: Snapshot,
): Promise<Record<string, unknown>> {
  const item = await items.getItem(d, a, itemId);
  const current: Record<string, unknown> = {};
  if ("amountCents" in after) current.amountCents = item.amountCents;
  if ("renewal" in after) current.renewal = item.renewal;
  if ("name" in after) current.name = item.name;
  if ("version" in after) current.version = item.version;
  if ("created" in after) current.created = true;
  if ("itemId" in after) current.itemId = item.id;
  if (after.occurrence) {
    const day = await items.listOccurrences(d, a, after.occurrence.dueDate, after.occurrence.dueDate, itemId);
    const occ = day.data.find((o) => o.id === after.occurrence?.id);
    current.occurrence = occ ? { ...after.occurrence, actualAmountCents: occ.actualAmountCents } : null;
  }
  return current;
}

/** True when any bill of the item has been paid, skipped or given an actual amount (so it is in use). */
async function itemInUse(d: items.ItemsDeps, a: Actor, itemId: string): Promise<boolean> {
  const all = await items.listOccurrences(d, a, "2000-01-01", "2100-12-31", itemId);
  return all.data.some((o) => o.status !== "scheduled" || o.actualAmountCents !== null);
}

/**
 * Restores `before` through the items service. Rejected after `undo_until`, when already undone, and when the
 * item was changed again since (restoring would overwrite someone's newer edit). Undoing a created item also
 * requires that nothing was paid or recorded on it (M4).
 */
export async function undo(deps: ReviewDeps, a: Actor, id: string): Promise<AppliedChange> {
  return inTx(deps, a, async (tx) => {
    const now = deps.now();
    const row = await repo.getApplied(tx, a.householdId, id, now, true);
    if (!row) throw notFound("Applied change");
    if (row.undoneAt) throw conflict("This change was already undone.");
    if (!row.undoable) throw conflict("The 30-day window to undo this change has passed.");
    if (row.entityType !== "item") throw conflict("This kind of change cannot be undone here.");

    const afterParsed = Snapshot.safeParse(row.after);
    const beforeParsed = row.before === null ? null : Snapshot.safeParse(row.before);
    if (!afterParsed.success || (beforeParsed && !beforeParsed.success)) {
      throw conflict("This change cannot be undone because its record is not readable.");
    }
    const after = afterParsed.data;
    const before = beforeParsed?.success ? beforeParsed.data : null;

    const d = itemsIn(tx, deps);
    const notFoundAsGone = (err: unknown): never => {
      if (err instanceof AppError && err.status === 404) throw gone();
      throw err;
    };

    // Whatever was written must still be there, unchanged.
    const current = await currentSnapshot(d, a, row.entityId, after).catch(notFoundAsGone);
    if (!snapshotMatches(after, current)) throw gone();

    if (before === null) {
      // The change created the item: undo removes it (soft delete, like any delete), unless it is in use.
      if (await itemInUse(d, a, row.entityId)) throw gone();
      const removed = await items.deleteItem(d, a, row.entityId).catch(notFoundAsGone);
      // The other member's item would become a proposal; an undo is all or nothing, so it stays blocked (the
      // proposal row is rolled back with this transaction).
      if (removed && "proposal" in removed) {
        throw new AppError(
          "approval_required",
          403,
          "This item belongs to your partner. Ask them to undo this change.",
        );
      }
    } else {
      if (before.occurrence) {
        const day = await items.listOccurrences(
          d,
          a,
          before.occurrence.dueDate,
          before.occurrence.dueDate,
          row.entityId,
        );
        const occ = day.data.find((o) => o.id === before.occurrence?.id);
        if (!occ) throw gone();
        await items.patchOccurrence(d, a, occ.id, occ.version, {
          actualAmountCents: before.occurrence.actualAmountCents,
        });
        // Setting an actual wrote an amount-history point; with nothing there before, remove it again.
        if (before.occurrence.actualAmountCents === null) {
          await items.deleteHistoryPoint(d, a, row.entityId, before.occurrence.dueDate);
        }
      }
      if ("amountCents" in before) {
        const item = await items.getItem(d, a, row.entityId);
        await items.patchItem(d, a, item.id, item.version, { amountCents: before.amountCents ?? null });
      }
      if ("renewal" in before) {
        if (before.renewal) await items.putRenewal(d, a, row.entityId, before.renewal);
        else await items.deleteRenewal(d, a, row.entityId);
      }
    }
    if (!(await repo.markUndone(tx, id, a.userId, now))) throw conflict("This change was already undone.");
    await repo.audit(tx, a.householdId, a.userId, "applied_change.undone", "applied_change", id);
    const updated = await repo.getApplied(tx, a.householdId, id, now);
    if (!updated) throw notFound("Applied change");
    return toApplied(updated);
  });
}

// ===== Sender rules =====
function toRule(row: repo.SenderRuleRow): SenderRule {
  return { ...row, categoryHint: row.categoryHint as SenderRule["categoryHint"] };
}

export async function listSenderRules(deps: ReviewDeps, a: Actor) {
  return inTx(deps, a, async (tx) => ({
    data: (await repo.listSenderRules(tx, a.householdId)).map(toRule),
  }));
}

export async function putSenderRule(deps: ReviewDeps, a: Actor, body: PutSenderRule) {
  return inTx(deps, a, async (tx) => {
    const { row, created } = await repo.upsertSenderRule(tx, a.householdId, a.userId, {
      domain: body.domain,
      rule: body.rule,
      categoryHint: body.categoryHint ?? null,
    });
    await repo.audit(tx, a.householdId, a.userId, "sender_rule.saved", "sender_rule", row.id);
    return { rule: toRule(row), created };
  });
}

// ===== Automation stats (Q-172) =====
/** Whole percent, rounded half up, in integer math. 0 when there is nothing to count. */
export function automationPercent(automated: number, hand: number): number {
  const total = automated + hand;
  return total === 0 ? 0 : Math.floor((automated * 200 + total) / (total * 2));
}

export async function automationStats(deps: ReviewDeps, a: Actor): Promise<AutomationStats> {
  return inTx(deps, a, async (tx) => {
    const counts = await repo.automationCounts(tx, a.householdId);
    if (!counts) throw notFound("Household");
    return {
      percent: automationPercent(counts.automated, counts.hand),
      automatedCount: counts.automated,
      handCount: counts.hand,
    };
  });
}
