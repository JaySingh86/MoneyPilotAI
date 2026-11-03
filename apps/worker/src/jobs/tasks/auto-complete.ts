// Job `tasks.auto_complete` (BACKEND_PLAN §7.4, §9): event-driven. Completes the open tasks whose
// `auto_complete_rule` waits for the event that just happened (an actual amount arriving by email or CSV, an
// item reviewed, a proposal decided) and records why. Idempotent: only open tasks complete, so the 3x
// retry policy is safe. The API runs the same function inline for events it handles itself.
import { z } from "zod";
import { autoCompleteTasks, type AutoCompleted, type WorkerDb } from "@mp/db";

export const TASKS_AUTO_COMPLETE_QUEUE = "tasks.auto_complete";

export const TasksAutoCompleteJob = z.object({
  householdId: z.uuid(),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("actual_amount_received"), itemId: z.uuid() }),
    z.object({ type: z.literal("item_reviewed"), itemId: z.uuid() }),
    z.object({ type: z.literal("proposal_decided"), proposalId: z.uuid() }),
  ]),
});
export type TasksAutoCompleteJob = z.infer<typeof TasksAutoCompleteJob>;

/** One running job per household and event subject. */
export function tasksAutoCompleteSingletonKey(job: TasksAutoCompleteJob): string {
  const subject = job.event.type === "proposal_decided" ? job.event.proposalId : job.event.itemId;
  return `${TASKS_AUTO_COMPLETE_QUEUE}:${job.event.type}:${subject}`;
}

export interface TasksAutoCompleteDeps {
  db: WorkerDb;
}

export async function handleTasksAutoComplete(
  deps: TasksAutoCompleteDeps,
  data: unknown,
): Promise<AutoCompleted[]> {
  const job = TasksAutoCompleteJob.parse(data);
  // A worker has no signed-in member: the audit event is a system event.
  return deps.db.withJobTx(job.householdId, (tx) => autoCompleteTasks(tx, job.householdId, job.event, null));
}
