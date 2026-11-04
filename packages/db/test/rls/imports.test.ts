// WP-16 table rules beyond plain isolation (the generic cross-household cases are in cases.ts): who may write which
// column of an import, the one-way status move for people, tenant-safe foreign keys and the worker-only transactions.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asWorkerA = <T>(fn: (tx: Tx) => Promise<T>) => worker.withJobTx(world.a.id, fn);

/** An import created the way the API does, then moved to `status` the way the worker does. */
async function newImport(status: "uploaded" | "needs_mapping" | "processing" = "uploaded"): Promise<string> {
  const id = randomUUID();
  await asA((tx) =>
    tx.execute(sql`insert into imports (id, household_id, uploaded_by, filename, status)
      values (${id}, ${world.a.id}, ${world.a.creator.id}, 'a.csv', 'uploaded')`),
  );
  if (status !== "uploaded") {
    await asWorkerA((tx) => tx.execute(sql`update imports set status = ${status} where id = ${id}`));
  }
  return id;
}

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("imports", () => {
  it("mp_api inserts only as the caller and only an `uploaded` import", async () => {
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into imports (household_id, uploaded_by, filename, status)
          values (${world.a.id}, ${world.a.partner.id}, 'x.csv', 'uploaded')`),
      ),
    );
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into imports (household_id, uploaded_by, filename, status)
          values (${world.a.id}, ${world.a.creator.id}, 'x.csv', 'done')`),
      ),
    );
  });

  it("a person can only queue an import for processing; everything else is the worker's", async () => {
    const id = await newImport();
    const attempts = [
      sql`fingerprint = 'x'`,
      sql`row_count = 1`,
      sql`added_count = 1`,
      sql`s3_key = 'x'`,
      sql`error = 'empty'`,
      sql`purged_at = now()`,
      sql`household_id = gen_random_uuid()`,
    ];
    for (const set of attempts) {
      await expectDenied(() => asA((tx) => tx.execute(sql`update imports set ${set} where id = ${id}`)));
    }
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`update imports set status = 'done' where id = ${id}`)),
    );
    // No mapping while the import does not need one.
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`update imports set mapping = '{"date":"d"}'::jsonb where id = ${id}`)),
    );
    const queued = await asA((tx) =>
      tx.execute(sql`update imports set status = 'processing' where id = ${id}`),
    );
    expect(queued.rowCount).toBe(1);
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`update imports set status = 'uploaded' where id = ${id}`)),
    );
  });

  it("a mapping can be chosen while the import needs one, together with queueing it", async () => {
    const id = await newImport("needs_mapping");
    const r = await asA((tx) =>
      tx.execute(
        sql`update imports set mapping = '{"date":"d"}'::jsonb, status = 'processing' where id = ${id}`,
      ),
    );
    expect(r.rowCount).toBe(1);
  });

  it("the worker records results and the check constraints hold", async () => {
    const id = await newImport("processing");
    const r = await asWorkerA((tx) =>
      tx.execute(sql`update imports set status = 'done', row_count = 5, added_count = 5, s3_key = null, purged_at = now()
        where id = ${id}`),
    );
    expect(r.rowCount).toBe(1);
    await expectRejected(
      () => asWorkerA((tx) => tx.execute(sql`update imports set error = 'some free text' where id = ${id}`)),
      CHECK_VIOLATION,
    );
    await expectRejected(
      () => asWorkerA((tx) => tx.execute(sql`update imports set row_count = -1 where id = ${id}`)),
      CHECK_VIOLATION,
    );
  });

  it("mp_worker cannot create an import (people upload files)", async () => {
    await expectDenied(() =>
      asWorkerA((tx) =>
        tx.execute(sql`insert into imports (household_id, uploaded_by, filename, status)
          values (${world.a.id}, ${world.a.creator.id}, 'w.csv', 'uploaded')`),
      ),
    );
  });
});

describe("transactions", () => {
  it("the API cannot write transactions; the worker can", async () => {
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into transactions (household_id, posted_on, description, merchant_norm, amount_cents, dedupe_hash)
          values (${world.a.id}, '2026-10-02', 'x', 'x', -1, ${randomBytes(32)})`),
      ),
    );
    await expectDenied(() => asA((tx) => tx.execute(sql`delete from transactions`)));
    await expectDenied(() => asA((tx) => tx.execute(sql`update transactions set amount_cents = 1`)));
    await asWorkerA((tx) =>
      tx.execute(sql`insert into transactions (household_id, posted_on, description, merchant_norm, amount_cents, dedupe_hash)
        values (${world.a.id}, '2026-10-02', 'x', 'x', -1, ${randomBytes(32)})`),
    );
  });

  it("the same dedupe hash cannot be stored twice for one household", async () => {
    const hash = randomBytes(32);
    const insert = () =>
      asWorkerA((tx) =>
        tx.execute(sql`insert into transactions (household_id, posted_on, description, merchant_norm, amount_cents, dedupe_hash)
          values (${world.a.id}, '2026-10-03', 'x', 'x', -1, ${hash})`),
      );
    await insert();
    await expectRejected(insert, UNIQUE_VIOLATION);
  });

  it("an import from another household cannot be referenced (tenant-safe foreign key)", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into transactions (household_id, import_id, posted_on, description, merchant_norm, amount_cents, dedupe_hash)
            values (${world.a.id}, ${world.b.imports.importId}, '2026-10-04', 'x', 'x', -1, ${randomBytes(32)})`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("the worker deletes only its own household's rows", async () => {
    expect(await asWorkerA((tx) => count(tx, sql`select 1 from transactions`))).toBeGreaterThan(0);
    const other = await worker.withJobTx(world.b.id, (tx) => count(tx, sql`select 1 from transactions`));
    await asWorkerA((tx) => tx.execute(sql`delete from transactions where posted_on < '2030-01-01'`));
    expect(await asWorkerA((tx) => count(tx, sql`select 1 from transactions`))).toBe(0);
    expect(await worker.withJobTx(world.b.id, (tx) => count(tx, sql`select 1 from transactions`))).toBe(
      other,
    );
  });
});

describe("import_mappings and extracted_items.import_id", () => {
  it("one mapping per header fingerprint and household", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into import_mappings (household_id, fingerprint, mapping, created_by)
            values (${world.a.id}, 'date|description|amount', '{}', ${world.a.creator.id})`),
        ),
      UNIQUE_VIOLATION,
    );
  });

  it("the worker reads mappings but cannot write them", async () => {
    expect(await asWorkerA((tx) => count(tx, sql`select 1 from import_mappings`))).toBe(1);
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`update import_mappings set mapping = '{"x":1}'::jsonb`)),
    );
  });

  it("a queue row cannot point at another household's import", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into extracted_items (household_id, source, import_id, extractor_version, fields, evidence, checks, match_type)
            values (${world.a.id}, 'csv', ${world.b.imports.importId}, 'csv.v1', '{}', '[]', '{}', 'new')`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});
