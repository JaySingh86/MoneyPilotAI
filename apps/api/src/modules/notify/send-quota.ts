// The database-backed per-user send quota (packages/notify defines the port). Shared across API processes: the
// count and the insert happen under one advisory lock per user, so two concurrent sends cannot both take the last slot.
import { sql } from "drizzle-orm";
import { INVITE_DAILY_QUOTA, type SendQuota } from "@mp/notify";
import type { ApiDb } from "@mp/db";

export interface DbSendQuotaOptions {
  limit?: number;
  /** Rolling window in hours. */
  windowHours?: number;
}

export function createDbSendQuota(db: ApiDb, options: DbSendQuotaOptions = {}): SendQuota {
  const limit = options.limit ?? INVITE_DAILY_QUOTA;
  const hours = options.windowHours ?? 24;
  return {
    async hasRoom(userId, kind) {
      return db.withHouseholdTx({ userId }, async (tx) => {
        const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from send_quota_events
          where user_id = ${userId} and kind = ${kind} and created_at > now() - make_interval(hours => ${hours})`);
        return Number(res.rows[0]?.n ?? 0) < limit;
      });
    },
    async consume(userId, kind) {
      return db.withHouseholdTx({ userId }, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`send_quota:${kind}:${userId}`}, 0))`,
        );
        const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from send_quota_events
          where user_id = ${userId} and kind = ${kind} and created_at > now() - make_interval(hours => ${hours})`);
        if (Number(res.rows[0]?.n ?? 0) >= limit) return false;
        await tx.execute(sql`insert into send_quota_events (user_id, kind) values (${userId}, ${kind})`);
        // Housekeeping: the owner may drop their own rows older than two days.
        await tx.execute(sql`delete from send_quota_events
          where user_id = ${userId} and created_at < now() - interval '2 days'`);
        return true;
      });
    },
  };
}
