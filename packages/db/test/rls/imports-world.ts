// WP-16 rows for the RLS world: an import and a saved mapping (written through mp_api, as the API does) and a
// transaction (written by the worker, as the import job does). Gives the cross-household tests a victim in each.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb, type ApiDb } from "../../src/tx";

interface Seeded {
  id: string;
  creator: { id: string };
}

export interface ImportsWorldRows {
  importId: string;
  transactionId: string;
  mappingId: string;
}

export async function seedImportsWorld(db: ApiDb, hh: Seeded): Promise<ImportsWorldRows> {
  const importId = randomUUID();
  const transactionId = randomUUID();
  const ctx = { userId: hh.creator.id, householdId: hh.id };
  const mappingId = await db.withHouseholdTx(ctx, async (tx) => {
    await tx.execute(sql`insert into imports (id, household_id, uploaded_by, s3_key, filename, size_bytes, status)
      values (${importId}, ${hh.id}, ${hh.creator.id}, ${`imports/${hh.id}/${importId}`}, 'bank.csv', 1200, 'uploaded')`);
    const rows = await tx.execute<{
      id: string;
    }>(sql`insert into import_mappings (household_id, fingerprint, mapping, created_by)
      values (${hh.id}, 'date|description|amount', '{"date":"date","description":"description","amount":"amount","amountSign":"outflow_negative"}',
        ${hh.creator.id}) returning id`);
    const id = rows.rows[0]?.id;
    if (!id) throw new Error("mapping insert returned no id");
    return id;
  });
  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(hh.id, (tx) =>
      tx.execute(sql`insert into transactions
          (id, household_id, import_id, posted_on, description, merchant_norm, amount_cents, dedupe_hash)
        values (${transactionId}, ${hh.id}, ${importId}, '2026-10-01', 'RENT PAYMENT', 'rent', -215000, ${randomBytes(32)})`),
    );
  } finally {
    await worker.close();
  }
  return { importId, transactionId, mappingId };
}
