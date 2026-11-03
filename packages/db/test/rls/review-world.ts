// WP-14 rows for the RLS world: a queued extracted item (written by the worker, as the email pipeline does),
// an applied change and a household sender rule (written through mp_api), plus a global sender rule is seeded
// by the migrator in review.test.ts. Gives the cross-household tests a victim in each review table.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb, type ApiDb } from "../../src/tx";

interface Seeded {
  id: string;
  creator: { id: string };
}

export interface ReviewWorldRows {
  extractedItemId: string;
  appliedChangeId: string;
  senderRuleId: string;
}

export async function seedReviewWorld(db: ApiDb, hh: Seeded, itemId: string): Promise<ReviewWorldRows> {
  const extractedItemId = randomUUID();
  const appliedChangeId = randomUUID();
  const ctx = { userId: hh.creator.id, householdId: hh.id };
  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(hh.id, (tx) =>
      tx.execute(sql`insert into extracted_items
          (id, household_id, source, extractor_version, fields, evidence, checks, message_meta, match_item_id, match_type)
        values (${extractedItemId}, ${hh.id}, 'email', 'extraction.v1', '{"amountDueCents": 216000}',
          '[{"field":"amountDueCents","quote":"Amount due $2,160.00"}]', '{"ok": true}',
          '{"fromDomain":"landlord.example","subject":"Rent notice","receivedAt":"2026-10-24T14:02:00Z"}',
          ${itemId}, 'update')`),
    );
  } finally {
    await worker.close();
  }
  const senderRuleId = await db.withHouseholdTx(ctx, async (tx) => {
    await tx.execute(sql`insert into applied_changes
        (id, household_id, origin, entity_type, entity_id, before, after, applied_by, undo_until)
      values (${appliedChangeId}, ${hh.id}, 'email', 'item', ${itemId}, '{"amountCents": 215000}',
        '{"amountCents": 216000}', ${hh.creator.id}, now() + interval '30 days')`);
    const rule = await tx.execute<{
      id: string;
    }>(sql`insert into sender_rules (household_id, domain, rule, created_by)
      values (${hh.id}, 'landlord.example', 'watch', ${hh.creator.id}) returning id`);
    const id = rule.rows[0]?.id;
    if (!id) throw new Error("sender rule insert returned no id");
    return id;
  });
  return { extractedItemId, appliedChangeId, senderRuleId };
}
