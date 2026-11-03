// Household tasks (WP-13; BACKEND_PLAN §5.2, §7.4, §8.2; DESIGN_SPEC §5.1 Tasks, §6 rule 15). Grouping and
// the nav badge come from `@mp/engine` (`tasksDueThisWeek`).
import { z } from "zod";
import { IsoDate, Timestamp, Uuid, Version } from "../common";
import { Owner } from "../items";

export const TASK_SOURCES = ["user", "engine", "email", "renewal", "setup"] as const;

/** What completes a task by itself (BACKEND_PLAN §7.4). Stored as `auto_complete_rule`. */
export const AutoCompleteRule = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("actual_amount_received"), itemId: Uuid }),
    z.object({ type: z.literal("item_reviewed"), itemId: Uuid }),
    z.object({ type: z.literal("proposal_decided"), proposalId: Uuid }),
  ])
  .meta({ id: "AutoCompleteRule" });
export type AutoCompleteRule = z.infer<typeof AutoCompleteRule>;

export const Task = z
  .object({
    id: Uuid,
    householdId: Uuid,
    title: z.string().min(1).max(140),
    ownerType: Owner,
    ownerUserId: Uuid.nullable(),
    dueOn: IsoDate.nullable(),
    /** "When the bill arrives, about Nov 1" for tasks without a firm date. */
    dueHint: z.string().nullable(),
    linkedItemId: Uuid.nullable(),
    /** The linked bill's name, for the Tasks screen; null when none or deleted. */
    linkedItemName: z.string().nullable(),
    source: z.enum(TASK_SOURCES),
    autoCompleteRule: AutoCompleteRule.nullable(),
    completed: z.boolean(),
    completedAt: Timestamp.nullable(),
    /** Null when the task completed itself. */
    completedBy: Uuid.nullable(),
    completedReason: z.string().nullable(),
    version: Version,
    /** Who added it ("Added by Sam"); null for tasks MoneyPilot made. */
    createdBy: Uuid.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "Task" });
export type Task = z.infer<typeof Task>;

/** `GET …/tasks`: the three groups of the Tasks screen and the nav badge. */
export const TaskGroups = z
  .object({
    dueThisWeek: z.array(Task),
    later: z.array(Task),
    done: z.array(Task),
    /** Open tasks due within 7 days, for every owner (rule 15). */
    navBadge: z.number().int().min(0),
  })
  .meta({ id: "TaskGroups" });
export type TaskGroups = z.infer<typeof TaskGroups>;

export const TaskListQuery = z.object({
  /** A member's user id (their tasks plus Both and Split, rule 13), or `both` / `split`. */
  owner: z.union([Uuid, z.enum(["both", "split"])]).optional(),
});

export const TaskParams = z.object({ hid: Uuid, id: Uuid });

const taskFields = z.object({
  title: z.string().min(1).max(140),
  ownerType: Owner,
  ownerUserId: Uuid.nullish(),
  dueOn: IsoDate.nullish(),
  dueHint: z.string().min(1).max(140).nullish(),
});

/** `POST …/tasks`: a task added by hand (source `user`). */
export const CreateTask = taskFields
  .strict()
  .refine((v) => (v.ownerType === "member") === (v.ownerUserId != null), {
    message: "A member owner needs ownerUserId; both and split must not have one",
    path: ["ownerUserId"],
  })
  .meta({ id: "CreateTask" });
export type CreateTask = z.infer<typeof CreateTask>;

/** `PATCH …/tasks/:id` with `If-Match`. `completed` completes or reopens the task. */
export const PatchTask = taskFields
  .extend({ completed: z.boolean() })
  .strict()
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field")
  .meta({ id: "PatchTask" });
export type PatchTask = z.infer<typeof PatchTask>;
