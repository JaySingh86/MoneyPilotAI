// WP-06 rows for the RLS world: one of everything in a household, written as the creator through mp_api
// (the way the API writes), so cross-household tests have victim rows in every items table.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb, type ApiDb } from "../../src/tx";
/** The part of a test household these rows need (kept structural so world.ts can import this file). */
interface Seeded {
  id: string;
  creator: { id: string };
}

export interface ItemsWorldRows {
  goalId: string;
  itemId: string;
  occurrenceId: string;
  goalEventId: string;
  proposalId: string;
  taskId: string;
}

export async function seedItemsWorld(db: ApiDb, hh: Seeded): Promise<ItemsWorldRows> {
  const goalId = randomUUID();
  const itemId = randomUUID();
  const ctx = { userId: hh.creator.id, householdId: hh.id };
  // The victim goal is created by the worker role (as the seed does).
  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(hh.id, (tx) =>
      tx.execute(sql`insert into goals (id, household_id, name, type, target_cents, is_emergency_fund, created_by)
        values (${goalId}, ${hh.id}, 'Emergency fund', 'savings', 1000000, true, ${hh.creator.id})`),
    );
  } finally {
    await worker.close();
  }
  const occurrenceId = await db.withHouseholdTx(ctx, async (tx) => {
    await tx.execute(sql`insert into recurring_items
        (id, household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, owner_type,
         owner_user_id, source, created_by)
      values (${itemId}, ${hh.id}, 'outflow', 'bill', 'housing', 'Rent', 'fixed', 215000, 'FREQ=MONTHLY;BYMONTHDAY=1',
         '2026-01-01', 'member', ${hh.creator.id}, 'manual', ${hh.creator.id})`);
    await tx.execute(sql`insert into renewal_details (item_id, household_id, auto_renews, coverage_end)
      values (${itemId}, ${hh.id}, 'yes', '2027-01-01')`);
    await tx.execute(sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
      values (${hh.id}, ${itemId}, '2026-09-01', 215000, 'manual')`);
    const occ = await tx.execute<{
      id: string;
    }>(sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
      values (${hh.id}, ${itemId}, '2026-11-01', '2026-11-01') returning id`);
    await tx.execute(sql`insert into planned_expenses (household_id, name, amount_cents, due_on, owner_type, created_by)
      values (${hh.id}, 'Thanksgiving', 25000, '2026-11-26', 'both', ${hh.creator.id})`);
    await tx.execute(sql`insert into balances (household_id, amount_cents, as_of, source, recorded_by)
      values (${hh.id}, 340000, '2026-10-27', 'manual', ${hh.creator.id})`);
    await tx.execute(sql`insert into calc_snapshots (household_id, engine_version, as_of, inputs_hash, result)
      values (${hh.id}, '1.0.0', '2026-10-27', ${randomBytes(32)}, '{}'::jsonb)`);
    const id = occ.rows[0]?.id;
    if (!id) throw new Error("occurrence insert returned no id");
    return id;
  });
  // WP-13 rows, written the way the API writes them.
  const wp13 = await db.withHouseholdTx(ctx, async (tx) => {
    const event = await tx.execute<{ id: string }>(sql`insert into goal_events
        (household_id, goal_id, kind, amount_cents, occurred_on, recorded_by)
      values (${hh.id}, ${goalId}, 'deposit', 30000, '2026-10-06', ${hh.creator.id}) returning id`);
    const proposal = await tx.execute<{ id: string }>(sql`insert into proposals
        (household_id, kind, payload, proposed_by, expires_at)
      values (${hh.id}, 'goal_change',
        ${JSON.stringify({ type: "goal_delete", goalId, goalName: "Emergency fund" })}::jsonb, ${hh.creator.id},
        now() + interval '7 days') returning id`);
    const task = await tx.execute<{ id: string }>(sql`insert into tasks
        (household_id, title, owner_type, due_on, linked_item_id, source, created_by)
      values (${hh.id}, 'Review rent', 'both', '2026-11-02', ${itemId}, 'user', ${hh.creator.id}) returning id`);
    return { goalEventId: event.rows[0]?.id, proposalId: proposal.rows[0]?.id, taskId: task.rows[0]?.id };
  });
  if (!wp13.goalEventId || !wp13.proposalId || !wp13.taskId) throw new Error("WP-13 world insert failed");
  return {
    goalId,
    itemId,
    occurrenceId,
    goalEventId: wp13.goalEventId,
    proposalId: wp13.proposalId,
    taskId: wp13.taskId,
  };
}
