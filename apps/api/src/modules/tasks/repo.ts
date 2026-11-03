// SQL for household tasks. Always called inside `withHouseholdTx`.
import { sql } from "drizzle-orm";
import type { AutoCompleteRule, Task } from "@mp/contracts";
import type { Tx } from "@mp/db";

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const TASK_COLUMNS = sql`id, household_id, title, owner_type, owner_user_id, due_on::text as due_on,
  due_hint, linked_item_id, source, created_by,
  (select i.name from recurring_items i where i.id = linked_item_id and i.deleted_at is null) as linked_item_name, auto_complete_rule, completed_by, completed_reason, version,
  to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as completed_at,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`;

export function toTask(r: Row): Task {
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    title: str(r.title),
    ownerType: r.owner_type as Task["ownerType"],
    ownerUserId: strOrNull(r.owner_user_id),
    dueOn: strOrNull(r.due_on),
    dueHint: strOrNull(r.due_hint),
    linkedItemId: strOrNull(r.linked_item_id),
    linkedItemName: strOrNull(r.linked_item_name),
    source: r.source as Task["source"],
    autoCompleteRule: (r.auto_complete_rule as AutoCompleteRule | null) ?? null,
    completed: r.completed_at !== null && r.completed_at !== undefined,
    completedAt: strOrNull(r.completed_at),
    completedBy: strOrNull(r.completed_by),
    completedReason: strOrNull(r.completed_reason),
    version: Number(r.version),
    createdBy: strOrNull(r.created_by),
    createdAt: str(r.created_at),
  };
}

export async function listTasks(tx: Tx, householdId: string): Promise<Task[]> {
  const res = await tx.execute(
    sql`select ${TASK_COLUMNS} from tasks where household_id = ${householdId} order by due_on nulls last, id`,
  );
  return res.rows.map(toTask);
}

export async function getTask(tx: Tx, householdId: string, id: string, lock = false): Promise<Task | null> {
  const res = await tx.execute(
    sql`select ${TASK_COLUMNS} from tasks where id = ${id} and household_id = ${householdId} ${lock ? sql`for update` : sql``}`,
  );
  const row = res.rows[0];
  return row ? toTask(row) : null;
}

export async function insertTask(
  tx: Tx,
  householdId: string,
  userId: string,
  t: {
    title: string;
    ownerType: string;
    ownerUserId: string | null;
    dueOn: string | null;
    dueHint: string | null;
  },
): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`insert into tasks
      (household_id, title, owner_type, owner_user_id, due_on, due_hint, source, created_by)
    values (${householdId}, ${t.title}, ${t.ownerType}::owner_type, ${t.ownerUserId}, ${t.dueOn}::date,
      ${t.dueHint}, 'user', ${userId}) returning id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("insert returned no id");
  return id;
}

export async function updateTask(
  tx: Tx,
  id: string,
  expectedVersion: number,
  c: Record<string, unknown>,
): Promise<boolean> {
  const sets = Object.keys(c).map((k) =>
    k === "due_on"
      ? sql`due_on = ${c[k]}::date`
      : k === "owner_type"
        ? sql`owner_type = ${c[k]}::owner_type`
        : k === "completed_at"
          ? c[k] === "now"
            ? sql`completed_at = now()`
            : sql`completed_at = null`
          : sql`${sql.identifier(k)} = ${c[k]}`,
  );
  const res = await tx.execute(
    sql`update tasks set ${sql.join(sets, sql`, `)} where id = ${id} and version = ${expectedVersion}`,
  );
  return (res.rowCount ?? 0) === 1;
}

export async function audit(
  tx: Tx,
  householdId: string,
  userId: string,
  action: string,
  id: string,
): Promise<void> {
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (${householdId}, ${userId}, 'user', ${action}, 'task', ${id})`);
}
