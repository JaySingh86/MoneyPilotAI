// Business rules for household tasks (BACKEND_PLAN §7.4, DESIGN_SPEC §6 rule 15). Grouping ("due this
// week", later, done) and the nav badge come from `@mp/engine` (`tasksDueThisWeek`).
import { AppError, type CreateTask, type PatchTask, type Task, type TaskGroups } from "@mp/contracts";
import type { Tx } from "@mp/db";
import { tasksDueThisWeek, type TaskInput } from "@mp/engine";
import { assertVersion } from "../../lib/if-match";
import { checkOwner, invalid, notFound, todayFor } from "../items/changes";
import { mapDbError, type Actor, type ItemsDeps } from "../items/service";
import * as repo from "./repo";

export type TasksDeps = ItemsDeps;

async function inTx<T>(deps: TasksDeps, a: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

function toInput(t: Task): TaskInput {
  return {
    id: t.id,
    title: t.title,
    owner: t.ownerType === "member" ? (t.ownerUserId ?? "") : t.ownerType,
    dueOn: t.dueOn,
    completed: t.completed,
  };
}

/** The Tasks screen groups and the nav badge for a household, as of `today` (household-local). */
export function groupTasks(tasks: readonly Task[], today: string, owner?: string): TaskGroups {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const groups = tasksDueThisWeek(tasks.map(toInput), today, { owner: owner ?? null });
  const back = (list: TaskInput[]): Task[] => list.flatMap((i) => byId.get(i.id) ?? []);
  return {
    dueThisWeek: back(groups.dueThisWeek),
    later: back(groups.later),
    done: back(groups.done),
    navBadge: groups.navBadge,
  };
}

/** The nav badge alone (the summary endpoint): open tasks due within 7 days, for every owner. */
export async function navBadge(tx: Tx, householdId: string, today: string): Promise<number> {
  return groupTasks(await repo.listTasks(tx, householdId), today).navBadge;
}

export async function listTasks(deps: TasksDeps, a: Actor, owner?: string): Promise<TaskGroups> {
  return inTx(deps, a, async (tx) => {
    const today = await todayFor(tx, deps, a.householdId);
    return groupTasks(await repo.listTasks(tx, a.householdId), today, owner);
  });
}

export async function getTask(deps: TasksDeps, a: Actor, id: string): Promise<Task> {
  return inTx(deps, a, async (tx) => {
    const task = await repo.getTask(tx, a.householdId, id);
    if (!task) throw notFound("Task");
    return task;
  });
}

export async function createTask(deps: TasksDeps, a: Actor, body: CreateTask): Promise<Task> {
  return inTx(deps, a, async (tx) => {
    await checkOwner(tx, a.householdId, body.ownerType, body.ownerUserId);
    const id = await repo.insertTask(tx, a.householdId, a.userId, {
      title: body.title,
      ownerType: body.ownerType,
      ownerUserId: body.ownerUserId ?? null,
      dueOn: body.dueOn ?? null,
      dueHint: body.dueHint ?? null,
    });
    await repo.audit(tx, a.householdId, a.userId, "task.created", id);
    const task = await repo.getTask(tx, a.householdId, id);
    if (!task) throw notFound("Task");
    return task;
  });
}

export async function patchTask(
  deps: TasksDeps,
  a: Actor,
  id: string,
  expected: number,
  body: PatchTask,
): Promise<Task> {
  return inTx(deps, a, async (tx) => {
    const current = await repo.getTask(tx, a.householdId, id, true);
    if (!current) throw notFound("Task");
    assertVersion(expected, current);

    const columns: Record<string, unknown> = {};
    if (body.title !== undefined) columns.title = body.title;
    if (body.dueOn !== undefined) columns.due_on = body.dueOn;
    if (body.dueHint !== undefined) columns.due_hint = body.dueHint;
    if (body.ownerType !== undefined || body.ownerUserId !== undefined) {
      const ownerType = body.ownerType ?? current.ownerType;
      const ownerUserId = body.ownerUserId !== undefined ? body.ownerUserId : current.ownerUserId;
      if ((ownerType === "member") !== (ownerUserId != null)) {
        throw invalid("ownerUserId", "A member owner needs ownerUserId; both and split must not have one.");
      }
      await checkOwner(tx, a.householdId, ownerType, ownerUserId);
      columns.owner_type = ownerType;
      columns.owner_user_id = ownerUserId ?? null;
    }
    let action = "task.updated";
    if (body.completed === true && !current.completed) {
      Object.assign(columns, { completed_at: "now", completed_by: a.userId, completed_reason: "manual" });
      action = "task.completed";
    } else if (body.completed === false && current.completed) {
      Object.assign(columns, { completed_at: null, completed_by: null, completed_reason: null });
      action = "task.reopened";
    }
    if (Object.keys(columns).length === 0) return current;
    if (!(await repo.updateTask(tx, id, expected, columns))) {
      throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
    }
    await repo.audit(tx, a.householdId, a.userId, action, id);
    const task = await repo.getTask(tx, a.householdId, id);
    if (!task) throw notFound("Task");
    return task;
  });
}
