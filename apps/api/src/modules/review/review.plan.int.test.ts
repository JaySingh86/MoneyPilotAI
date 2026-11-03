// The decision response carries a fresh plan read from the engine (Q-121); the review service computes nothing.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { acceptInvite, createHousehold, ensureUser, inviteMember } from "@mp/db/testing";
import { key } from "../../auth/testing/app";
import { createReviewTestApi, type ReviewTestApi } from "./testing";

let t: ReviewTestApi;
let worker: WorkerDb;
let householdId: string;
let userId: string;
let sam: Record<string, string>;
const base = () => `/v1/households/${householdId}`;

beforeAll(async () => {
  t = await createReviewTestApi("2026-11-03T16:00:00Z");
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  const creator = await ensureUser(t.db, {
    authSubject: `review-plan|${randomUUID()}`,
    email: `plan-${randomUUID().slice(0, 8)}@example.test`,
    firstName: "Sam",
  });
  const partner = await ensureUser(t.db, {
    authSubject: `review-plan|${randomUUID()}`,
    email: `plan2-${randomUUID().slice(0, 8)}@example.test`,
    firstName: "Jordan",
  });
  householdId = randomUUID();
  await createHousehold(t.db, creator, {
    id: householdId,
    name: "Plan household",
    timezone: "America/New_York",
    forwardingToken: `plan-${householdId.slice(0, 8)}`,
  });
  await acceptInvite(t.db, partner, (await inviteMember(t.db, creator, householdId, partner.email)).token);
  userId = creator.id;
  sam = await t.as(creator.authSubject, { claims: { email: creator.email } });
}, 180_000);

afterAll(async () => {
  await t?.close();
  await worker?.close();
});

const post = (url: string, payload: object) =>
  t.app.inject({ method: "POST", url: `${base()}${url}`, headers: { ...sam, ...key() }, payload });

async function bill(over: Record<string, unknown>) {
  const res = await post("/items", {
    direction: "outflow",
    kind: "bill",
    category: "other",
    name: `Item ${randomUUID().slice(0, 6)}`,
    amountType: "fixed",
    amountCents: 14900,
    schedule: { type: "monthly_day", day: 12, dtstart: "2026-11-12" },
    ownerType: "member",
    ownerUserId: userId,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

async function queueAmount(itemId: string, amountDueCents: number): Promise<string> {
  const id = randomUUID();
  const fields = {
    docType: "bill",
    providerName: "Gym",
    category: "other",
    insuranceType: null,
    amountDueCents,
    previousAmountCents: null,
    dueDate: null,
    renewalDate: null,
    cancelByDate: null,
    decisionByDate: null,
    frequency: null,
    autoRenews: null,
    accountLast4: null,
    providerDomain: null,
  };
  await worker.withJobTx(householdId, (tx) =>
    tx.execute(sql`insert into extracted_items
        (id, household_id, source, extractor_version, fields, evidence, checks, match_item_id, match_type)
      values (${id}, ${householdId}, 'email', 'x', ${JSON.stringify(fields)}::jsonb, '[]', '{}', ${itemId}, 'update')`),
  );
  return id;
}

describe("fresh plan on the decision (Q-121)", () => {
  it("is null before onboarding, then the engine's safe to spend", async () => {
    const item = await bill({});
    const first = await post(`/review-items/${await queueAmount(item.id, 15500)}/confirm`, {});
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().plan).toBeNull();

    const income = await bill({
      direction: "inflow",
      kind: "income",
      category: "income",
      name: "Paycheck",
      amountCents: 300000,
      schedule: { type: "every_n_weeks", n: 2, dtstart: "2026-11-06" },
    });
    const hh = await t.app.inject({ method: "GET", url: base(), headers: sam });
    const patched = await t.app.inject({
      method: "PATCH",
      url: base(),
      headers: { ...sam, ...key(), "if-match": String(hh.headers.etag) },
      payload: { primaryIncomeItemId: income.id },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const balance = await post("/balances", { label: "Checking", amountCents: 500000, asOf: "2026-11-03" });
    expect(balance.statusCode, balance.body).toBe(201);

    const second = await post(`/review-items/${await queueAmount(item.id, 17000)}/confirm`, {});
    expect(second.statusCode, second.body).toBe(200);
    expect(Number.isInteger(second.json().plan.safeToSpendCents)).toBe(true);
  });
});
