// Cross-household test cases, one per table that has a `household_id` column.
// test/rls/coverage.test.ts fails if a table with household_id exists without an entry here, so a WP
// that adds a household table must add its case in the same PR (ADR-003, ARCHITECTURE §8).
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

export interface AttackTarget {
  /** The victim household. */
  householdId: string;
  /** The attacker's own user id (null for worker jobs). */
  actorUserId: string | null;
  /** Some user in the attacker's reach, for tables that need a user reference. */
  someUserId: string;
}

export interface HouseholdTableCase {
  table: string;
  /** Insert one row into the victim household. Must fail with 42501 for every attacker. */
  insert(target: AttackTarget): SQL;
  /** Update the victim's rows using a column app roles may write where possible. Must touch 0 rows or fail. */
  update(target: AttackTarget): SQL;
}

export const householdTableCases: readonly HouseholdTableCase[] = [
  {
    table: "household_members",
    insert: (t) => sql`insert into household_members (household_id, user_id, color_role, is_creator)
      values (${t.householdId}, ${t.actorUserId ?? t.someUserId}, 'partnerB', false)`,
    update: (t) => sql`update household_members set left_at = now() where household_id = ${t.householdId}`,
  },
  {
    table: "invites",
    insert: (t) => sql`insert into invites (household_id, email, token_hash, invited_by, expires_at)
      values (${t.householdId}, ${`attacker-${randomBytes(4).toString("hex")}@example.test`}, ${randomBytes(32)},
              ${t.actorUserId ?? t.someUserId}, now() + interval '7 days')`,
    update: (t) => sql`update invites set revoked_at = now() where household_id = ${t.householdId}`,
  },
  {
    table: "audit_events",
    insert: (t) => sql`insert into audit_events (household_id, actor_user_id, actor_type, action)
      values (${t.householdId}, ${t.actorUserId}, ${t.actorUserId ? "user" : "system"}, 'rls.probe')`,
    update: (t) => sql`update audit_events set action = 'tampered' where household_id = ${t.householdId}`,
  },
  // ===== WP-06: items, schedules, renewals, occurrences, planned expenses, balances, goals =====
  {
    table: "goals",
    insert: (t) => sql`insert into goals (household_id, name, type, target_cents)
      values (${t.householdId}, 'Attacker goal', 'savings', 100000)`,
    update: (t) => sql`update goals set name = 'tampered' where household_id = ${t.householdId}`,
  },
  {
    table: "recurring_items",
    insert: (t) => sql`insert into recurring_items
        (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, owner_type, source)
      values (${t.householdId}, 'outflow', 'bill', 'other', 'Attacker bill', 'fixed', 100,
        'FREQ=MONTHLY;BYMONTHDAY=1', '2026-01-01', 'both', 'manual')`,
    update: (t) => sql`update recurring_items set notes = 'tampered' where household_id = ${t.householdId}`,
  },
  {
    table: "renewal_details",
    insert: (t) =>
      sql`insert into renewal_details (item_id, household_id) values (${randomUUID()}, ${t.householdId})`,
    update: (t) =>
      sql`update renewal_details set cancel_by = '2026-01-01' where household_id = ${t.householdId}`,
  },
  {
    table: "item_amount_history",
    insert: (
      t,
    ) => sql`insert into item_amount_history (household_id, item_id, occurred_on, amount_cents, source)
      values (${t.householdId}, ${randomUUID()}, '2026-01-01', 100, 'manual')`,
    update: (t) => sql`update item_amount_history set amount_cents = 1 where household_id = ${t.householdId}`,
  },
  {
    table: "occurrences",
    insert: (t) => sql`insert into occurrences (household_id, item_id, scheduled_on, due_on)
      values (${t.householdId}, ${randomUUID()}, '2026-12-01', '2026-12-01')`,
    update: (t) => sql`update occurrences set due_on = '2026-12-31' where household_id = ${t.householdId}`,
  },
  {
    table: "planned_expenses",
    insert: (t) => sql`insert into planned_expenses (household_id, name, amount_cents, due_on, owner_type)
      values (${t.householdId}, 'Attacker expense', 100, '2026-12-01', 'both')`,
    update: (t) => sql`update planned_expenses set name = 'tampered' where household_id = ${t.householdId}`,
  },
  {
    table: "balances",
    insert: (t) => sql`insert into balances (household_id, amount_cents, as_of, source)
      values (${t.householdId}, 1, '2026-10-27', 'manual')`,
    update: (t) => sql`update balances set amount_cents = 1 where household_id = ${t.householdId}`,
  },
];
