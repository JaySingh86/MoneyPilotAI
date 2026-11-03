// Task auto-completion (BACKEND_PLAN §7.4, DESIGN_SPEC §6 rule 15). A task may carry an `auto_complete_rule`;
// when the event it names happens, the task completes itself and records why. Shared by the API (an actual
// amount typed in, a proposal decided) and the worker (an actual amount arriving by email or CSV), which
// call it inside the transaction that handled the event, as mp_api or mp_worker: RLS scopes it to one
// household either way. Idempotent: only open tasks complete.
import { sql } from "drizzle-orm";
import type { Tx } from "../tx";

/** The events a task rule can wait for. Rule JSON: `{ "type": "...", "itemId" | "proposalId": "<uuid>" }`. */
export type AutoCompleteEvent =
  | { type: "actual_amount_received"; itemId: string }
  | { type: "item_reviewed"; itemId: string }
  | { type: "proposal_decided"; proposalId: string };

export interface AutoCompleted {
  taskId: string;
  title: string;
}

/**
 * Completes the household's open tasks whose rule matches `event`. `actorUserId` is the member whose request
 * caused the event (the audit actor); null for a worker, which records a system event. The completion itself
 * has no `completed_by`: it was automatic.
 */
export async function autoCompleteTasks(
  tx: Tx,
  householdId: string,
  event: AutoCompleteEvent,
  actorUserId: string | null,
): Promise<AutoCompleted[]> {
  const key = event.type === "proposal_decided" ? "proposalId" : "itemId";
  const subject = event.type === "proposal_decided" ? event.proposalId : event.itemId;
  const res = await tx.execute<{ id: string; title: string }>(sql`update tasks
      set completed_at = now(), completed_reason = ${event.type}
    where household_id = ${householdId} and completed_at is null
      and auto_complete_rule ->> 'type' = ${event.type} and auto_complete_rule ->> ${key} = ${subject}
    returning id, title`);
  for (const task of res.rows) {
    await tx.execute(sql`insert into audit_events
        (household_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata)
      values (${householdId}, ${actorUserId}, ${actorUserId ? "user" : "system"}, 'task.auto_completed', 'task',
        ${task.id}, ${JSON.stringify({ reason: event.type })}::jsonb)`);
  }
  return res.rows.map((r) => ({ taskId: r.id, title: r.title }));
}
