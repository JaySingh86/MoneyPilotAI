// WP-14 table rules beyond plain isolation (the generic cross-household cases are in cases.ts): who may write
// which column of the review queue, the immutable undo log, tenant-safe foreign keys and the global
// sender list.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asWorkerA = <T>(fn: (tx: Tx) => Promise<T>) => worker.withJobTx(world.a.id, fn);

/** A queued extraction written the way the pipeline does (as the worker). */
async function queuedItem(householdId: string, source: "email" | "csv" = "email", state = "queued") {
  const id = randomUUID();
  await worker.withJobTx(householdId, (tx) =>
    tx.execute(sql`insert into extracted_items (id, household_id, source, extractor_version, fields, evidence, checks, match_type, state)
      values (${id}, ${householdId}, ${source}, 'x', '{}', '[]', '{}', 'new', ${state})`),
  );
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

describe("extracted_items", () => {
  it("mp_api reads but cannot insert queue rows (only the pipelines do)", async () => {
    expect(await asA((tx) => count(tx, sql`select 1 from extracted_items`))).toBe(1);
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into extracted_items (household_id, source, extractor_version, fields, evidence, checks, match_type)
          values (${world.a.id}, 'email', 'x', '{}', '[]', '{}', 'new')`),
      ),
    );
  });

  it("mp_api decides but cannot rewrite where an item came from", async () => {
    for (const column of ["evidence", "checks", "message_meta", "source", "match_item_id", "household_id"]) {
      await expectDenied(() =>
        asA((tx) =>
          tx.execute(
            sql`update extracted_items set ${sql.identifier(column)} = ${column === "source" ? sql`'csv'` : column === "household_id" || column === "match_item_id" ? sql`gen_random_uuid()` : sql`'{}'::jsonb`}
              where id = ${world.a.review.extractedItemId}`,
          ),
        ),
      );
    }
    // A fresh queued row: a decision is one-way (L3).
    const id = await queuedItem(world.a.id);
    const decided = await asA((tx) =>
      tx.execute(sql`update extracted_items set state = 'ignored', decided_by = ${world.a.creator.id}, decided_at = now()
        where id = ${id}`),
    );
    expect(decided.rowCount).toBe(1);
    await expectRejected(
      () => asA((tx) => tx.execute(sql`update extracted_items set state = 'queued' where id = ${id}`)),
      "23514",
    );
    await expectRejected(
      () => asA((tx) => tx.execute(sql`update extracted_items set fields = '{"x":1}' where id = ${id}`)),
      "23514",
    );
  });

  it("a decision is recorded as the caller, not as the partner", async () => {
    const id = await queuedItem(world.a.id);
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`update extracted_items set state = 'confirmed', decided_by = ${world.a.partner.id}, decided_at = now()
          where id = ${id}`),
      ),
    );
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`update extracted_items set state = 'confirmed' where id = ${id}`)),
    );
  });

  it("the state is one of the six allowed values", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(
            sql`update extracted_items set state = 'applied', decided_by = ${world.a.creator.id} where id = ${world.a.review.extractedItemId}`,
          ),
        ),
      "23514",
    );
  });

  it("a matched item must be in the same household (composite foreign key)", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into extracted_items
              (household_id, source, extractor_version, fields, evidence, checks, match_item_id, match_type)
            values (${world.a.id}, 'email', 'x', '{}', '[]', '{}', ${world.b.items.itemId}, 'update')`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("fields must be an object and evidence an array", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into extracted_items (household_id, source, extractor_version, fields, evidence, checks, match_type)
            values (${world.a.id}, 'email', 'x', '[]', '[]', '{}', 'new')`),
        ),
      "23514",
    );
  });
});

describe("applied_changes", () => {
  it("only the undo columns can change, and only by the caller", async () => {
    for (const column of [
      "before",
      "after",
      "undo_until",
      "applied_at",
      "applied_by",
      "entity_id",
      "origin",
    ]) {
      const value =
        column === "applied_by" || column === "entity_id"
          ? sql`gen_random_uuid()`
          : column === "undo_until" || column === "applied_at"
            ? sql`now()`
            : column === "origin"
              ? sql`'user'`
              : sql`'{}'::jsonb`;
      await expectDenied(() =>
        asA((tx) =>
          tx.execute(
            sql`update applied_changes set ${sql.identifier(column)} = ${value} where id = ${world.a.review.appliedChangeId}`,
          ),
        ),
      );
    }
    // Recording an undo as somebody else is refused by the policy.
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`update applied_changes set undone_at = now(), undone_by = ${world.a.partner.id}
          where id = ${world.a.review.appliedChangeId}`),
      ),
    );
  });

  it("the undo pair is set together", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(
            sql`update applied_changes set undone_at = now() where id = ${world.a.review.appliedChangeId}`,
          ),
        ),
      // Fails the policy check (undone_by must be the caller) or the pair check; either way nothing changes.
      "42501",
    );
  });

  it("mp_api cannot delete the log, and cannot attribute a change to someone else", async () => {
    await expectDenied(() =>
      asA((tx) => tx.execute(sql`delete from applied_changes where id = ${world.a.review.appliedChangeId}`)),
    );
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into applied_changes (household_id, origin, entity_type, entity_id, after, applied_by)
          values (${world.a.id}, 'user', 'item', ${randomUUID()}, '{}', ${world.a.partner.id})`),
      ),
    );
  });

  it("the worker writes automatic changes (applied_by null)", async () => {
    await asWorkerA((tx) =>
      tx.execute(sql`insert into applied_changes (household_id, origin, entity_type, entity_id, after, undo_until)
        values (${world.a.id}, 'email', 'item', ${world.a.items.itemId}, '{}', now() + interval '30 days')`),
    );
    expect(await asA((tx) => count(tx, sql`select 1 from applied_changes where applied_by is null`))).toBe(1);
  });
});

describe("sender_rules", () => {
  it("members see their own rules, never another household's", async () => {
    const own = await asA((tx) =>
      count(tx, sql`select 1 from sender_rules where household_id = ${world.a.id}`),
    );
    expect(own).toBe(1);
    const other = await asA((tx) =>
      count(tx, sql`select 1 from sender_rules where household_id = ${world.b.id}`),
    );
    expect(other).toBe(0);
  });

  it("no app role can write the global list (household_id null)", async () => {
    await expectDenied(() =>
      asA((tx) =>
        tx.execute(sql`insert into sender_rules (household_id, domain, rule, created_by)
        values (null, 'global-attack.example', 'ignore', ${world.a.creator.id})`),
      ),
    );
    await expectDenied(() =>
      asWorkerA((tx) =>
        tx.execute(sql`insert into sender_rules (household_id, domain, rule)
        values (null, 'global-attack.example', 'ignore')`),
      ),
    );
  });

  it("a household has one rule per domain, and manages only its own", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into sender_rules (household_id, domain, rule, created_by)
          values (${world.a.id}, 'landlord.example', 'ignore', ${world.a.creator.id})`),
        ),
      UNIQUE_VIOLATION,
    );
    const changedOther = await asA((tx) =>
      tx.execute(sql`update sender_rules set rule = 'ignore' where id = ${world.b.review.senderRuleId}`),
    );
    expect(changedOther.rowCount).toBe(0);
    const deletedOther = await asA((tx) =>
      tx.execute(sql`delete from sender_rules where id = ${world.b.review.senderRuleId}`),
    );
    expect(deletedOther.rowCount).toBe(0);
    expect(
      await asA((tx) => count(tx, sql`select 1 from sender_rules where id = ${world.a.review.senderRuleId}`)),
    ).toBe(1);
  });

  it("domains are stored lower-case", async () => {
    await expectRejected(
      () =>
        asA((tx) =>
          tx.execute(sql`insert into sender_rules (household_id, domain, rule, created_by)
          values (${world.a.id}, 'Mixed.Example', 'watch', ${world.a.creator.id})`),
        ),
      "23514",
    );
  });
});
