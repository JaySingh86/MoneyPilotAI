// Nav badges for `GET /households/:hid/summary` (BACKEND_PLAN §7.4, §8.2): open tasks due within 7 days
// (from the engine, rule 15) and proposals waiting for this member.
import { sql } from "drizzle-orm";
import { householdToday } from "@mp/db";
import type { SummaryBadges } from "../households/service";
import { navBadge } from "./service";

/** `now` is the request clock (UTC instant); calendar days are derived with the household time zone. */
export function tasksSummaryBadges(now: () => string = () => new Date().toISOString()): SummaryBadges {
  return {
    async counts(tx, { householdId, userId, timezone }) {
      const tasksDue = await navBadge(tx, householdId, householdToday(now(), timezone));
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from proposals
        where household_id = ${householdId} and status = 'pending' and proposed_by <> ${userId}
          and expires_at > ${now()}::timestamptz`);
      return { tasksDue, proposalsPending: Number(res.rows[0]?.n ?? 0) };
    },
  };
}
