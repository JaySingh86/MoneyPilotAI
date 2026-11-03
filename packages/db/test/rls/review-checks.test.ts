// WP-14 shape checks (M1, L1, L6) and the review-created item policy (Q-124).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);

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

describe("shape checks (M1, L1, L6)", () => {
  const insertMeta = (meta: unknown) =>
    worker.withJobTx(world.a.id, (tx) =>
      tx.execute(sql`insert into extracted_items (household_id, source, extractor_version, fields, evidence, checks, match_type, message_meta)
        values (${world.a.id}, 'email', 'x', '{}', '[]', '{}', 'new', ${JSON.stringify(meta)}::jsonb)`),
    );
  const ok = { fromDomain: "a.example", subject: "Hello", receivedAt: "2026-10-24T14:02:00Z" };

  it("message_meta has exactly fromDomain, subject (<= 300 or null) and receivedAt", async () => {
    await insertMeta(ok);
    await insertMeta({ ...ok, subject: null });
    await expectRejected(() => insertMeta({ ...ok, body: "the whole email" }), "23514");
    await expectRejected(() => insertMeta({ ...ok, subject: "x".repeat(301) }), "23514");
    await expectRejected(() => insertMeta({ ...ok, subject: 42 }), "23514");
    await expectRejected(() => insertMeta({ subject: "x", receivedAt: ok.receivedAt }), "23514");
    await expectRejected(() => insertMeta({ ...ok, receivedAt: 1 }), "23514");
    await expectRejected(() => insertMeta([]), "23514");
  });

  it("an item change row has an object to restore from and compare with", async () => {
    const insert = (before: string | null, after: string) =>
      asA((tx) =>
        tx.execute(sql`insert into applied_changes (household_id, origin, entity_type, entity_id, before, after, applied_by)
          values (${world.a.id}, 'user', 'item', ${randomUUID()}, ${before}::jsonb, ${after}::jsonb, ${world.a.creator.id})`),
      );
    await insert(null, "{}");
    await expectRejected(() => insert(null, "5"), "23514");
    await expectRejected(() => insert("[]", "{}"), "23514");
  });

  it("sender rule domains are valid lower-case hostnames", async () => {
    const insert = (domain: string) =>
      asA((tx) =>
        tx.execute(sql`insert into sender_rules (household_id, domain, rule, created_by)
          values (${world.a.id}, ${domain}, 'watch', ${world.a.creator.id})`),
      );
    await insert("good-one.example.com");
    for (const bad of [
      "localhost",
      "has space.example",
      "-bad.example",
      "a..example",
      "x@y.example",
      "Upper.example",
    ]) {
      await expectRejected(() => insert(bad), "23514");
    }
  });
});

describe("items created from a review (Q-124)", () => {
  const insertItem = (
    householdId: string,
    userId: string,
    source: string,
    name: string,
    review: string | null,
  ) =>
    api.withHouseholdTx({ userId, householdId }, async (tx) => {
      if (review) await tx.execute(sql`select set_config('app.review_item_id', ${review}, true)`);
      return tx.execute(sql`insert into recurring_items
          (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, owner_type, owner_user_id, source, created_by)
        values (${householdId}, 'outflow', 'bill', 'other', ${name}, 'fixed', 100, 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-11-01',
          'member', ${userId}, ${source}, ${userId})`);
    });

  it("is allowed only inside a decision about a queued item of the same household and source", async () => {
    const h = world.a.id;
    const u = world.a.creator.id;
    const queued = await queuedItem(h, "email");
    await insertItem(h, u, "email", "From email", queued);
    // The general policy is still manual-only.
    await expectDenied(() => insertItem(h, u, "email", "No review", null));
    // The review must be the same household's.
    const foreign = await queuedItem(world.b.id, "email");
    await expectDenied(() => insertItem(h, u, "email", "Foreign review", foreign));
    // The item's source is the review's source, never another.
    await expectDenied(() => insertItem(h, u, "csv", "Wrong source", queued));
    await expectDenied(() => insertItem(h, u, "bank", "Bank source", queued));
    // A review that is no longer queued cannot create items.
    const decided = await queuedItem(h, "email", "ignored");
    await expectDenied(() => insertItem(h, u, "email", "Decided review", decided));
    // Nor can a user who is not a member.
    await expectDenied(() => insertItem(h, world.b.creator.id, "email", "Not a member", queued));
    // The csv source works with a csv review.
    const csv = await queuedItem(h, "csv");
    await insertItem(h, u, "csv", "From csv", csv);
  });
});
