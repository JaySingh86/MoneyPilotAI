// WP-15 rows for the RLS world: a default reminder rule, one in-app notification for each member (written by the
// OTHER member through mp_api, as a proposal or invite hook does) and an email delivery for each (written by the
// worker, as the dispatcher does). Gives the cross-household tests a victim in each notification table, and every
// actor with a household member's identity something of their own to read.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb, type ApiDb } from "../../src/tx";

interface Seeded {
  id: string;
  creator: { id: string };
  partner: { id: string };
}

export interface NotifyWorldRows {
  ruleId: string;
  /** The notification addressed to the creator, and to the partner. */
  creatorNotificationId: string;
  partnerNotificationId: string;
}

export async function seedNotifyWorld(db: ApiDb, hh: Seeded): Promise<NotifyWorldRows> {
  const ruleId = randomUUID();
  const creatorNotificationId = randomUUID();
  const partnerNotificationId = randomUUID();
  const as = (userId: string) => ({ userId, householdId: hh.id });

  await db.withHouseholdTx(as(hh.creator.id), async (tx) => {
    await tx.execute(sql`insert into reminder_rules (id, household_id) values (${ruleId}, ${hh.id})`);
    await tx.execute(sql`insert into notifications (id, household_id, user_id, kind, dedupe_key, title, body, send_at)
      values (${partnerNotificationId}, ${hh.id}, ${hh.partner.id}, 'system', ${`seed:${partnerNotificationId}`},
              'Seed notice', 'For the partner', now() - interval '1 minute')`);
  });
  await db.withHouseholdTx(as(hh.partner.id), (tx) =>
    tx.execute(sql`insert into notifications (id, household_id, user_id, kind, dedupe_key, title, body, send_at)
      values (${creatorNotificationId}, ${hh.id}, ${hh.creator.id}, 'system', ${`seed:${creatorNotificationId}`},
              'Seed notice', 'For the creator', now() - interval '1 minute')`),
  );

  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(hh.id, async (tx) => {
      for (const id of [creatorNotificationId, partnerNotificationId]) {
        await tx.execute(sql`insert into notification_deliveries
            (household_id, notification_id, channel, provider_message_id, status, attempts)
          values (${hh.id}, ${id}, 'email', ${`seed-${id}`}, 'sent', 1)`);
      }
    });
  } finally {
    await worker.close();
  }
  return { ruleId, creatorNotificationId, partnerNotificationId };
}
