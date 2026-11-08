// WP-21 rows for the RLS world: an email connection (inserted through mp_api the way the OAuth callback does,
// with a fake sealed token) and a message row (written by the worker, as discover does). Gives the
// cross-household tests a victim in each table.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb, type ApiDb } from "../../src/tx";

interface Seeded {
  id: string;
  creator: { id: string };
}

export interface EmailWorldRows {
  connectionId: string;
  messageId: string;
  addressHash: Buffer;
}

export async function seedEmailWorld(db: ApiDb, hh: Seeded): Promise<EmailWorldRows> {
  const connectionId = randomUUID();
  const messageId = randomUUID();
  const addressHash = randomBytes(32);
  await db.withHouseholdTx({ userId: hh.creator.id, householdId: hh.id }, (tx) =>
    tx.execute(sql`insert into email_connections
        (id, household_id, user_id, provider, address_masked, address_hash, scopes, token_ciphertext, token_dek_wrapped, token_key_id)
      values (${connectionId}, ${hh.id}, ${hh.creator.id}, 'gmail', 'sam•••@gmail.com', ${addressHash},
        array['https://www.googleapis.com/auth/gmail.readonly'], ${randomBytes(48)}, ${randomBytes(60)}, 'local:test')`),
  );
  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(hh.id, (tx) =>
      tx.execute(sql`insert into email_messages
          (id, household_id, connection_id, channel, provider_message_id, received_at, from_domain, stage)
        values (${messageId}, ${hh.id}, ${connectionId}, 'gmail', ${`m-${messageId}`}, '2026-10-24T14:02:00Z',
          'landlord.example', 'discovered')`),
    );
  } finally {
    await worker.close();
  }
  return { connectionId, messageId, addressHash };
}
