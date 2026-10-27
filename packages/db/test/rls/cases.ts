// Cross-household test cases, one per table that has a `household_id` column.
// test/rls/coverage.test.ts fails if a table with household_id exists without an entry here, so a WP
// that adds a household table must add its case in the same PR (ADR-003, ARCHITECTURE §8).
import { randomBytes } from "node:crypto";
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
];
