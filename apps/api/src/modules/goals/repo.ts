// SQL for goals and goal events. Always called inside `withHouseholdTx`.
import { sql } from "drizzle-orm";
import type { GoalEvent } from "@mp/contracts";
import type { Tx } from "@mp/db";

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const cents = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("money out of range");
  return n;
};

export const GOAL_COLUMNS = sql`id, household_id, name, type, target_cents::text as target_cents,
  saved_cents::text as saved_cents, monthly_cents::text as monthly_cents, target_date::text as target_date,
  color_slot, is_emergency_fund, status, version,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at`;

/** A goal row without its engine progress (added by the service). */
export interface GoalRow {
  id: string;
  householdId: string;
  name: string;
  type: "savings" | "planned_expense";
  targetCents: number;
  savedCents: number;
  monthlyCents: number;
  targetDate: string | null;
  colorSlot: number;
  isEmergencyFund: boolean;
  status: "active" | "reached" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toGoalRow(r: Row): GoalRow {
  return {
    id: str(r.id),
    householdId: str(r.household_id),
    name: str(r.name),
    type: r.type as GoalRow["type"],
    targetCents: cents(r.target_cents),
    savedCents: cents(r.saved_cents),
    monthlyCents: cents(r.monthly_cents),
    targetDate: strOrNull(r.target_date),
    colorSlot: Number(r.color_slot),
    isEmergencyFund: r.is_emergency_fund === true,
    status: r.status as GoalRow["status"],
    version: Number(r.version),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

/** Goals shown on the Goals screen: not deleted, not archived. */
export async function listGoals(tx: Tx, householdId: string): Promise<GoalRow[]> {
  const res = await tx.execute(sql`select ${GOAL_COLUMNS} from goals
    where household_id = ${householdId} and deleted_at is null and status <> 'archived'
    order by color_slot, created_at, id`);
  return res.rows.map(toGoalRow);
}

export async function getGoal(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<GoalRow | null> {
  const res = await tx.execute(
    sql`select ${GOAL_COLUMNS} from goals
      where id = ${id} and household_id = ${householdId} and deleted_at is null ${lock ? sql`for update` : sql``}`,
  );
  const row = res.rows[0];
  return row ? toGoalRow(row) : null;
}

export interface NewGoal {
  name: string;
  type: string;
  targetCents: number;
  savedCents: number;
  monthlyCents: number;
  targetDate: string | null;
  colorSlot: number;
  isEmergencyFund: boolean;
  status: string;
}

export async function insertGoal(tx: Tx, householdId: string, userId: string, g: NewGoal): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`insert into goals
      (household_id, name, type, target_cents, saved_cents, monthly_cents, target_date, color_slot,
       is_emergency_fund, status, created_by)
    values (${householdId}, ${g.name}, ${g.type}, ${g.targetCents}, ${g.savedCents}, ${g.monthlyCents},
      ${g.targetDate}::date, ${g.colorSlot}, ${g.isEmergencyFund}, ${g.status}, ${userId}) returning id`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("insert returned no id");
  return id;
}

/** Updates the named columns of a goal at the version the caller read. */
export async function updateGoal(
  tx: Tx,
  id: string,
  expectedVersion: number,
  c: Record<string, unknown>,
): Promise<boolean> {
  const sets = Object.keys(c).map((k) =>
    k === "target_date" ? sql`target_date = ${c[k]}::date` : sql`${sql.identifier(k)} = ${c[k]}`,
  );
  const res = await tx.execute(
    sql`update goals set ${sql.join(sets, sql`, `)} where id = ${id} and version = ${expectedVersion}`,
  );
  return (res.rowCount ?? 0) === 1;
}

export async function softDeleteGoal(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`update goals set deleted_at = now() where id = ${id}`);
}

export async function insertEvent(
  tx: Tx,
  householdId: string,
  userId: string,
  goalId: string,
  e: { kind: string; amountCents: number; occurredOn: string; note: string | null },
): Promise<GoalEvent> {
  const res = await tx.execute(sql`insert into goal_events
      (household_id, goal_id, kind, amount_cents, occurred_on, note, recorded_by)
    values (${householdId}, ${goalId}, ${e.kind}, ${e.amountCents}, ${e.occurredOn}::date, ${e.note}, ${userId})
    returning id, goal_id, kind, amount_cents::text as amount_cents, occurred_on::text as occurred_on, note,
      recorded_by, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`);
  const r = res.rows[0];
  if (!r) throw new Error("insert returned no row");
  return {
    id: str(r.id),
    goalId: str(r.goal_id),
    kind: r.kind as GoalEvent["kind"],
    amountCents: cents(r.amount_cents),
    occurredOn: str(r.occurred_on),
    note: strOrNull(r.note),
    recordedBy: strOrNull(r.recorded_by),
    createdAt: str(r.created_at),
  };
}

export async function audit(
  tx: Tx,
  householdId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (${householdId}, ${userId}, 'user', ${action}, ${entityType}, ${entityId})`);
}
