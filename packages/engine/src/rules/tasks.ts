// Rule 15: "Due this week" means due within 7 days of today, inclusive (overdue open tasks included). The
// nav badge counts the open tasks in that group for the whole household.
import { compareDates, compareStrings, parseDate } from "../dates";
import type { IsoDate, OwnerKey, TaskInput } from "../types";
import { ownerMatches } from "./owners";

export const DUE_THIS_WEEK_DAYS = 7;

export interface TaskGroups {
  dueThisWeek: TaskInput[];
  /** Due later, or with no due date. */
  later: TaskInput[];
  done: TaskInput[];
  /** Open tasks due within 7 days, for every owner. */
  navBadge: number;
}

function byDue(a: TaskInput, b: TaskInput): number {
  if (a.dueOn === b.dueOn) return compareStrings(a.id, b.id);
  if (a.dueOn === null) return 1;
  if (b.dueOn === null) return -1;
  return compareStrings(a.dueOn, b.dueOn);
}

/** Groups tasks for the Tasks screen. `owner` applies rule 13: that member's tasks plus Both and Split. */
export function tasksDueThisWeek(
  tasks: readonly TaskInput[],
  asOf: IsoDate,
  options: { owner?: OwnerKey | null } = {},
): TaskGroups {
  const weekEnd = parseDate(asOf, "asOf").add({ days: DUE_THIS_WEEK_DAYS });
  const thisWeek = (t: TaskInput) =>
    !t.completed && t.dueOn !== null && compareDates(parseDate(t.dueOn, "task.dueOn"), weekEnd) <= 0;
  const sorted = [...tasks].sort(byDue);
  const shown = sorted.filter((t) => ownerMatches(t.owner, options.owner ?? null));
  return {
    dueThisWeek: shown.filter(thisWeek),
    later: shown.filter((t) => !t.completed && !thisWeek(t)),
    done: shown.filter((t) => t.completed),
    navBadge: sorted.filter(thisWeek).length,
  };
}
