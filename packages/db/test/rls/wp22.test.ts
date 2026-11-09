// WP-22 rules beyond plain isolation (the generic cross-household cases are in cases.ts): the `auto_apply` flag is off
// by default and no app role can turn it on, model-run records are the worker's to write and a member's to read,
// an extracted item can only point at a message of its own household, one message yields one review row, and the
// worker cannot rewrite what a message is.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asCreatorA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asStranger = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.stranger.id, authSubject: world.stranger.authSubject }, fn);
const asWorkerA = <T>(fn: (tx: Tx) => Promise<T>) => worker.withJobTx(world.a.id, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("households.auto_apply_enabled", () => {
  it("is off by default", async () => {
    const res = await asWorkerA((tx) =>
      tx.execute<{ auto_apply_enabled: boolean }>(
        sql`select auto_apply_enabled from households where id = ${world.a.id}`,
      ),
    );
    expect(res.rows[0]?.auto_apply_enabled).toBe(false);
  });

  it("no app role can turn it on", async () => {
    await expectDenied(() =>
      asCreatorA((tx) => tx.execute(sql`update households set auto_apply_enabled = true`)),
    );
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`update households set auto_apply_enabled = true`)),
    );
    const res = await asWorkerA((tx) =>
      tx.execute<{ auto_apply_enabled: boolean }>(
        sql`select auto_apply_enabled from households where id = ${world.a.id}`,
      ),
    );
    expect(res.rows[0]?.auto_apply_enabled).toBe(false);
  });
});

describe("ai_runs", () => {
  const insert = (householdId: string) => sql`insert into ai_runs
      (household_id, purpose, model_id, prompt_version, status, input_tokens, output_tokens)
    values (${householdId}, 'extract', 'claude-opus-5-5', 'extract.v1', 'ok', 10, 5)`;

  it("a member reads their household's runs and nobody else's; a stranger reads none", async () => {
    expect(await asCreatorA((tx) => count(tx, sql`select id from ai_runs`))).toBeGreaterThan(0);
    expect(
      await asCreatorA((tx) => count(tx, sql`select id from ai_runs where household_id = ${world.b.id}`)),
    ).toBe(0);
    expect(await asStranger((tx) => count(tx, sql`select id from ai_runs`))).toBe(0);
  });

  it("the API cannot write runs; the worker writes only its own household's", async () => {
    await expectDenied(() => asCreatorA((tx) => tx.execute(insert(world.a.id))));
    await asWorkerA((tx) => tx.execute(insert(world.a.id)));
    await expectDenied(() => asWorkerA((tx) => tx.execute(insert(world.b.id))));
    await expectDenied(() => asWorkerA((tx) => tx.execute(sql`update ai_runs set status = 'error'`)));
    await expectDenied(() => asWorkerA((tx) => tx.execute(sql`delete from ai_runs`)));
  });

  it("never stores a prompt or an output: the table has no such column", async () => {
    const res = await asWorkerA((tx) =>
      tx.execute<{ column_name: string }>(
        sql`select a.attname as column_name from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.relname = 'ai_runs' and a.attnum > 0 and not a.attisdropped`,
      ),
    );
    const names = res.rows.map((r) => r.column_name);
    expect(names.filter((n) => /^(prompt|output|response|content|text|body)$/.test(n))).toEqual([]);
  });
});

describe("extracted_items.message_id", () => {
  const insertItem = (messageId: string | null, householdId = world.a.id) => sql`insert into extracted_items
      (household_id, source, message_id, extractor_version, fields, evidence, checks, match_type)
    values (${householdId}, 'email', ${messageId}, 'extract.v1', '{}', '[]', '{}', 'new')`;

  it("can only point at a message of its own household (tenant-safe foreign key)", async () => {
    await expectRejected(
      () => asWorkerA((tx) => tx.execute(insertItem(world.b.email.messageId))),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("one message yields at most one review row, even on a retry", async () => {
    const messageId = randomUUID();
    await asWorkerA((tx) =>
      tx.execute(sql`insert into email_messages
          (id, household_id, channel, provider_message_id, received_at, from_domain, stage)
        values (${messageId}, ${world.a.id}, 'gmail', ${`once-${messageId}`}, now(), 'x.example', 'discovered')`),
    );
    await asWorkerA((tx) => tx.execute(insertItem(messageId)));
    await expectRejected(() => asWorkerA((tx) => tx.execute(insertItem(messageId))), UNIQUE_VIOLATION);
    // Rows without a message (CSV, or a purged message) are not limited.
    await asWorkerA((tx) => tx.execute(insertItem(null)));
    await asWorkerA((tx) => tx.execute(insertItem(null)));
  });
});

describe("email_messages (WP-22 columns)", () => {
  it("the worker sets the batch id, but cannot change how a message was found", async () => {
    const messageId = randomUUID();
    await asWorkerA((tx) =>
      tx.execute(sql`insert into email_messages
          (id, household_id, channel, provider_message_id, received_at, from_domain, stage, intake)
        values (${messageId}, ${world.a.id}, 'gmail', ${`batch-${messageId}`}, now(), 'x.example', 'discovered',
          'backfill')`),
    );
    const set = await asWorkerA((tx) =>
      tx.execute(sql`update email_messages set ai_batch_id = 'msgbatch_test' where id = ${messageId}`),
    );
    expect(set.rowCount).toBe(1);
    await expectDenied(() =>
      asWorkerA((tx) =>
        tx.execute(sql`update email_messages set intake = 'discover' where id = ${messageId}`),
      ),
    );
    // The API reads these columns but never writes them.
    await expectDenied(() =>
      asCreatorA((tx) => tx.execute(sql`update email_messages set ai_batch_id = null`)),
    );
  });

  it("only known intakes are accepted", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into email_messages
              (household_id, channel, provider_message_id, received_at, from_domain, stage, intake)
            values (${world.a.id}, 'gmail', ${`bad-${randomUUID()}`}, now(), 'x.example', 'discovered', 'push')`),
        ),
      "23514",
    );
  });
});
