// The worker's items-apply port (Q-125): what an AUTOMATIC change may write, with the same guards as the API's
// items service (apps/api/src/modules/items/{service,changes}.ts), which the worker cannot import.
//
//   what it writes   only what `planAutoApply` (review-rules) allows: the actual amount on the one upcoming bill whose
//                    due date the email names, or nothing at all (an identical notice). Never an item's amount, owner,
//                    status, schedule or renewal details (M2).
//   the same guards  the bill must exist for a live (not deleted) active item, still be `scheduled` (no paid, skipped
//                    or settled bill is rewritten), be changed under its version (a concurrent edit makes this refuse),
//                    and the amount it replaces must be an estimate: an actual already there is never overwritten
//                    (the same value is a no-op, a different one is refused).
//   the same effects the actual amount is also a data point for the item's estimate (`item_amount_history`, source
//                    `email`) and may complete a task that waits for it (`autoCompleteTasks`); one audit event.
//   what it returns  the `before` / `after` snapshots in the shape the API's undo reads (`Snapshot` in
//                    apps/api/src/modules/review/service.ts), so a change made here is undone by the same code.
//
// Refusals are values, not errors: the caller sends the item to review instead (a person can still confirm it).
import { sql } from "drizzle-orm";
import { autoCompleteTasks, type Tx } from "@mp/db";
import type { ExtractedFields } from "@mp/contracts";
import { planAutoApply, type AutoApplyChange } from "@mp/review-rules";

export type ApplyRefusal = "item_gone" | "no_occurrence" | "not_scheduled" | "conflict";

export type AutoApplied =
  | {
      ok: true;
      entityId: string;
      /** The values the change replaced; `{}` when it changed nothing. Never null (null means "created the item"). */
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      /** The item whose estimate changed; the caller refreshes its plan and reminders. */
      wrote: boolean;
    }
  | { ok: false; code: ApplyRefusal };

type Row = Record<string, unknown>;

/**
 * What an identical notice records as `after`: the item, and (`display`) the amount and due date the email confirmed, so
 * "Applied automatically" can say "Internet, $70.00 due Nov 5". They are copied from the validated extraction, never
 * computed; undo ignores `display`.
 */
export function noopAfter(itemId: string, f: ExtractedFields): Record<string, unknown> {
  return {
    itemId,
    display: { amountCents: f.amountDueCents, dueDate: f.dueDate ?? f.renewalDate },
  };
}

export async function applyAutomaticChange(
  tx: Tx,
  input: { householdId: string; itemId: string; change: AutoApplyChange; fields: ExtractedFields },
): Promise<AutoApplied> {
  const { householdId, itemId } = input;
  const plan = planAutoApply(input.change, input.fields);

  // The item must still exist and be live: an occurrence of a soft-deleted item is gone for everyone.
  const item = (
    await tx.execute<Row>(sql`select id, status from recurring_items
      where id = ${itemId} and household_id = ${householdId} and deleted_at is null`)
  ).rows[0];
  if (!item || item.status === "ended") return { ok: false, code: "item_gone" };

  if (plan.occurrenceActual === null) {
    // An identical notice: nothing to write. The undo log still records that we saw it and what it matched.
    return { ok: true, entityId: itemId, before: {}, after: noopAfter(itemId, input.fields), wrote: false };
  }
  const { dueDate, amountCents } = plan.occurrenceActual;

  const occ = (
    await tx.execute<Row>(sql`select o.id, o.status, o.version, o.actual_amount_cents::text as actual_amount_cents
      from occurrences o join recurring_items i on i.id = o.item_id and i.household_id = o.household_id
      where o.item_id = ${itemId} and o.household_id = ${householdId} and o.due_on = ${dueDate}::date
        and i.deleted_at is null
      order by o.id limit 1 for update of o`)
  ).rows[0];
  if (!occ) return { ok: false, code: "no_occurrence" };
  if (occ.status !== "scheduled") return { ok: false, code: "not_scheduled" };

  const occurrenceId = String(occ.id);
  const previous = occ.actual_amount_cents === null ? null : Number(occ.actual_amount_cents);
  if (previous === amountCents) {
    // Already says so: the same no-op as an identical notice.
    return { ok: true, entityId: itemId, before: {}, after: noopAfter(itemId, input.fields), wrote: false };
  }

  // A different actual is already there (a person typed it, or an earlier message set it): an automatic change never
  // overwrites it. A person can still confirm the new value from the review queue.
  if (previous !== null) return { ok: false, code: "conflict" };

  const moved = await tx.execute(sql`update occurrences set actual_amount_cents = ${amountCents}
    where id = ${occurrenceId} and household_id = ${householdId} and version = ${Number(occ.version)}`);
  if ((moved.rowCount ?? 0) !== 1) return { ok: false, code: "conflict" };

  // Not `on conflict do update`: the worker may insert a data point but not rewrite one (column grants). A point
  // the same source already wrote for that day is left alone (a repeat of the same message).
  await tx.execute(sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
    select ${householdId}, ${itemId}, ${dueDate}::date, ${amountCents}, 'email'
    where not exists (select 1 from item_amount_history
      where item_id = ${itemId} and occurred_on = ${dueDate}::date and source = 'email')`);
  await autoCompleteTasks(tx, householdId, { type: "actual_amount_received", itemId }, null);
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (${householdId}, null, 'system', 'occurrence.updated', 'occurrence', ${occurrenceId})`);

  return {
    ok: true,
    entityId: itemId,
    before: { occurrence: { id: occurrenceId, dueDate, actualAmountCents: previous } },
    after: { occurrence: { id: occurrenceId, dueDate, actualAmountCents: amountCents } },
    wrote: true,
  };
}
