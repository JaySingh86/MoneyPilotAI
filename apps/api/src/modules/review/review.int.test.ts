// Review queue + applied changes against a real Postgres (RLS as mp_api): the §8.3 payload, the confirm / edit /
// ignore state machine, atomic apply through the items service, the 30-day undo and tenant isolation.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { acceptInvite, createHousehold, ensureUser, inviteMember } from "@mp/db/testing";
import type { ExtractedFields } from "@mp/contracts";
import { key } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";
import { hasPriorDecidedFromSender } from "./repo";
import { createReviewTestApi, type ReviewTestApi } from "./testing";

let t: ReviewTestApi;
let worker: WorkerDb;
let seeded: { householdId: string; userIds: { creator: string; partner: string } };
let sam: Record<string, string>;
let jordan: Record<string, string>;
let stranger: { id: string; headers: Record<string, string> };

const base = () => `/v1/households/${seeded.householdId}`;
const SAM = () => seeded.userIds.creator;
const JORDAN = () => seeded.userIds.partner;
const NOW = "2026-11-03T16:00:00Z";

beforeAll(async () => {
  t = await createReviewTestApi(NOW);
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  // Own household (not the Rivera fixture: items.int.test.ts seeds that one into the same database).
  const profile = (label: string) => ({
    authSubject: `review|${label}|${randomUUID()}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    firstName: label,
  });
  const creator = await ensureUser(t.db, profile("sam"));
  const partner = await ensureUser(t.db, profile("jordan"));
  const householdId = randomUUID();
  await createHousehold(t.db, creator, {
    id: householdId,
    name: "Review household",
    timezone: "America/New_York",
    forwardingToken: `review-${householdId.slice(0, 8)}`,
  });
  await acceptInvite(t.db, partner, (await inviteMember(t.db, creator, householdId, partner.email)).token);
  seeded = { householdId, userIds: { creator: creator.id, partner: partner.id } };
  sam = await t.as(creator.authSubject, { claims: { email: creator.email } });
  jordan = await t.as(partner.authSubject, { claims: { email: partner.email } });
  stranger = await t.signUp("stranger");
}, 180_000);

afterAll(async () => {
  await t?.close();
  await worker?.close();
});

const fields = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({
  docType: "renewal_notice",
  providerName: "Northgate Home Insurance",
  category: "insurance",
  insuranceType: "renters",
  amountDueCents: 16800,
  previousAmountCents: 14900,
  dueDate: null,
  renewalDate: "2027-01-09",
  cancelByDate: null,
  decisionByDate: null,
  frequency: null,
  autoRenews: null,
  accountLast4: "4821",
  providerDomain: null,
  ...over,
});

const call = (
  method: "GET" | "POST" | "PATCH",
  url: string,
  headers: Record<string, string>,
  payload?: object,
) =>
  t.app.inject({
    method,
    url: `${base()}${url}`,
    headers: method === "GET" ? headers : { ...headers, ...key() },
    ...(payload ? { payload } : {}),
  });

async function createBill(over: Record<string, unknown> = {}) {
  const res = await call("POST", "/items", sam, {
    direction: "outflow",
    kind: "insurance",
    category: "insurance",
    name: `Renters ${randomUUID().slice(0, 6)}`,
    providerName: "Northgate Home Insurance",
    providerDomain: "northgate-insurance.example",
    amountType: "fixed",
    amountCents: 14900,
    schedule: { type: "yearly", dtstart: "2026-01-09" },
    ownerType: "member",
    ownerUserId: SAM(),
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number; amountCents: number | null; renewal: unknown };
}

/** Queues an extraction the way the email pipeline (a worker job) does. */
async function queue(opts: {
  matchItemId?: string | null;
  matchType?: "new" | "update" | "decision" | "duplicate";
  fields?: ExtractedFields;
  fromDomain?: string;
  state?: string;
  source?: "email" | "csv";
  subject?: string;
  /** Stored as is (to simulate a row the contract cannot read). */
  rawFields?: unknown;
}): Promise<string> {
  const id = randomUUID();
  const f = opts.rawFields ?? opts.fields ?? fields();
  await worker.withJobTx(seeded.householdId, (tx) =>
    tx.execute(sql`insert into extracted_items
        (id, household_id, source, extractor_version, fields, evidence, checks, message_meta, match_item_id, match_type, state)
      values (${id}, ${seeded.householdId}, ${opts.source ?? "email"}, 'extraction.v1', ${JSON.stringify(f)}::jsonb,
        ${JSON.stringify([{ field: "amountDueCents", quote: "Your renewal premium is $168.00" }])}::jsonb, '{"ok":true}'::jsonb,
        ${JSON.stringify({ fromDomain: opts.fromDomain ?? "northgate-insurance.example", subject: opts.subject ?? "Your renewal offer for policy •••4821", receivedAt: "2026-10-24T14:02:00Z" })}::jsonb,
        ${opts.matchItemId ?? null}, ${opts.matchType ?? "update"}, ${opts.state ?? "queued"})`),
  );
  return id;
}

const getProviderDomain = async (id: string) =>
  ((await call("GET", `/items/${id}`, sam)).json() as { providerDomain: string | null }).providerDomain;

const getItem = async (id: string) =>
  (await call("GET", `/items/${id}`, sam)).json() as {
    amountCents: number | null;
    version: number;
    deletedAt?: unknown;
    renewal: { coverageEnd: string | null; cancelBy: string | null; autoRenews: string } | null;
    ownerUserId: string;
    source: string;
  };

describe("queue payload (BACKEND_PLAN §8.3)", () => {
  it("returns the review item shape, oldest first, with a cursor", async () => {
    const item = await createBill({ name: "Renters (shape)" });
    const first = await queue({ matchItemId: item.id });
    const second = await queue({ matchItemId: item.id });
    const res = await call("GET", "/review-items?limit=1", jordan);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.nextCursor).toEqual(expect.any(String));
    const row = body.data[0];
    expect(row).toMatchObject({
      source: "email",
      state: "queued",
      matchType: "update",
      matchItemId: item.id,
      message: {
        fromDomain: "northgate-insurance.example",
        subject: "Your renewal offer for policy •••4821",
        receivedAt: "2026-10-24T14:02:00Z",
      },
      fields: {
        docType: "renewal_notice",
        providerName: "Northgate Home Insurance",
        amountDueCents: 16800,
        previousAmountCents: 14900,
        renewalDate: "2027-01-09",
        accountLast4: "4821",
      },
      evidence: [{ field: "amountDueCents", quote: "Your renewal premium is $168.00" }],
      effect: { summary: "Updates Renters (shape) and flags a price change.", planDelta: null },
      appliedChangeId: null,
    });
    // Nothing of an email body exists anywhere in the payload.
    expect(Object.keys(row).sort()).toEqual(
      [
        "appliedChangeId",
        "createdAt",
        "decidedAt",
        "decidedBy",
        "effect",
        "evidenceStale",
        "evidence",
        "fields",
        "id",
        "matchItemId",
        "matchType",
        "message",
        "source",
        "state",
      ].sort(),
    );
    const next = await call(
      "GET",
      `/review-items?limit=5&cursor=${encodeURIComponent(body.nextCursor)}`,
      jordan,
    );
    const ids = [row.id, ...next.json().data.map((r: { id: string }) => r.id)];
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
    expect(ids).toContain(second);
  });

  it("filters by state and rejects a bad cursor or state", async () => {
    const decided = await queue({ state: "ignored" });
    const ignored = (await call("GET", "/review-items?state=ignored", sam)).json().data as { id: string }[];
    expect(ignored.map((r) => r.id)).toContain(decided);
    expectProblem(await call("GET", "/review-items?cursor=garbage", sam), 400, "validation_failed");
    expectProblem(await call("GET", "/review-items?state=bogus", sam), 400, "validation_failed");
  });
});

describe("confirm", () => {
  it("applies the change atomically with an applied_changes row (undo_until = now + 30 days)", async () => {
    const item = await createBill({ name: "Renters (confirm)" });
    const id = await queue({ matchItemId: item.id });
    const res = await call("POST", `/review-items/${id}/confirm`, jordan);
    expect(res.statusCode, res.body).toBe(200);
    const { item: decided, appliedChange } = res.json();
    expect(decided).toMatchObject({
      state: "confirmed",
      decidedBy: JORDAN(),
      appliedChangeId: appliedChange.id,
    });
    expect(appliedChange).toMatchObject({
      origin: "email",
      entityType: "item",
      entityId: item.id,
      appliedBy: JORDAN(),
      appliedAt: NOW,
      undoUntil: "2026-12-03T16:00:00Z",
      undoneAt: null,
      undoable: true,
      before: { amountCents: 14900, renewal: null },
      after: { amountCents: 16800, renewal: { coverageEnd: "2027-01-09", previousAmountCents: 14900 } },
    });
    const now = await getItem(item.id);
    expect(now.amountCents).toBe(16800);
    expect(now.renewal).toMatchObject({ coverageEnd: "2027-01-09", autoRenews: "yes" });
    // The same row shows under "Applied automatically".
    const list = (await call("GET", "/applied-changes", sam)).json().data as { id: string }[];
    expect(list.map((c) => c.id)).toContain(appliedChange.id);
  });

  it("a second decision is a 409 and changes nothing more", async () => {
    const item = await createBill({ name: "Renters (twice)" });
    const id = await queue({ matchItemId: item.id });
    expect((await call("POST", `/review-items/${id}/confirm`, sam)).statusCode).toBe(200);
    expectProblem(await call("POST", `/review-items/${id}/confirm`, sam), 409, "conflict");
    expectProblem(await call("POST", `/review-items/${id}/ignore`, sam), 409, "conflict");
    expectProblem(
      await call("POST", `/review-items/${id}/edit`, sam, { fields: { amountDueCents: 1 } }),
      409,
      "conflict",
    );
  });

  it("two concurrent confirms apply exactly once", async () => {
    const item = await createBill({ name: "Renters (race)" });
    const id = await queue({ matchItemId: item.id });
    const [a, b] = await Promise.all([
      call("POST", `/review-items/${id}/confirm`, sam),
      call("POST", `/review-items/${id}/confirm`, jordan),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const changes = (await call("GET", "/applied-changes?limit=100", sam)).json().data as {
      entityId: string;
    }[];
    expect(changes.filter((c) => c.entityId === item.id)).toHaveLength(1);
  });

  it("rolls everything back when a later step fails (item edit, change row and state commit together)", async () => {
    const item = await createBill({ name: "Renters (rollback)" });
    const id = await queue({ matchItemId: item.id });
    await t.admin((c) =>
      c.query(`create function wp14_fail_fn() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
        create trigger wp14_fail before insert on applied_changes for each row when (new.household_id = '${seeded.householdId}') execute function wp14_fail_fn();`),
    );
    try {
      const res = await call("POST", `/review-items/${id}/confirm`, sam);
      expect(res.statusCode).toBe(500);
    } finally {
      await t.admin((c) =>
        c.query(`drop trigger wp14_fail on applied_changes; drop function wp14_fail_fn();`),
      );
    }
    expect((await getItem(item.id)).amountCents).toBe(14900);
    const still = (await call("GET", `/review-items/${id}`, sam)).json();
    expect(still).toMatchObject({ state: "queued", appliedChangeId: null });
  });

  it("an estimated item gets the actual on its occurrence, and undo puts it back", async () => {
    const item = await createBill({
      name: "Electric (estimate)",
      kind: "bill",
      category: "utilities",
      amountType: "estimated",
      amountCents: 10000,
      schedule: { type: "monthly_day", day: 20, dtstart: "2026-11-20" },
      providerDomain: "power.example",
    });
    const id = await queue({
      matchItemId: item.id,
      fromDomain: "power.example",
      fields: fields({
        docType: "bill",
        category: "utilities",
        insuranceType: null,
        amountDueCents: 12345,
        previousAmountCents: null,
        dueDate: "2026-11-20",
        renewalDate: null,
      }),
    });
    const res = await call("POST", `/review-items/${id}/confirm`, sam);
    expect(res.statusCode, res.body).toBe(200);
    const change = res.json().appliedChange;
    expect(change.after.occurrence).toMatchObject({ dueDate: "2026-11-20", actualAmountCents: 12345 });
    const occ = async () =>
      (
        (
          await t.app.inject({
            method: "GET",
            url: `${base()}/occurrences?from=2026-11-20&to=2026-11-20&itemId=${item.id}`,
            headers: sam,
          })
        ).json().data as { actualAmountCents: number | null }[]
      )[0];
    expect((await occ())?.actualAmountCents).toBe(12345);
    expect((await call("POST", `/applied-changes/${change.id}/undo`, sam)).statusCode).toBe(200);
    expect((await occ())?.actualAmountCents).toBeNull();
  });

  it("a decision applies dates only; a duplicate applies nothing", async () => {
    const item = await createBill({ name: "Renters (decision)" });
    const decision = await queue({
      matchItemId: item.id,
      matchType: "decision",
      fields: fields({
        docType: "enrollment_deadline",
        amountDueCents: null,
        previousAmountCents: null,
        renewalDate: null,
        decisionByDate: "2026-12-01",
      }),
    });
    const r = await call("POST", `/review-items/${decision}/confirm`, sam);
    expect(r.json().appliedChange.after).toMatchObject({ renewal: { decisionBy: "2026-12-01" } });
    expect((await getItem(item.id)).amountCents).toBe(14900);
    const dup = await queue({ matchItemId: item.id, matchType: "duplicate" });
    const d = await call("POST", `/review-items/${dup}/confirm`, sam);
    expect(d.json()).toMatchObject({
      item: { state: "confirmed", appliedChangeId: null },
      appliedChange: null,
    });
  });

  it("creates a new item owned by the person who confirmed it", async () => {
    const id = await queue({
      matchType: "new",
      fromDomain: "pawsure.example",
      fields: fields({
        providerName: "Pawsure Pet Insurance",
        insuranceType: "pet",
        amountDueCents: 4200,
        previousAmountCents: null,
        renewalDate: null,
        dueDate: "2026-11-25",
        frequency: "monthly",
        accountLast4: null,
      }),
    });
    const res = await call("POST", `/review-items/${id}/confirm`, jordan);
    expect(res.statusCode, res.body).toBe(200);
    const change = res.json().appliedChange;
    expect(change).toMatchObject({
      before: null,
      entityName: "Pawsure Pet Insurance",
      after: { created: true, name: "Pawsure Pet Insurance" },
    });
    const created = await getItem(change.entityId);
    expect(created).toMatchObject({ ownerUserId: JORDAN(), amountCents: 4200, source: "email" });
    // The sender domain is never copied into the item automatically (M3).
    expect(await getProviderDomain(change.entityId)).toBeNull();
    // Undo removes it again.
    expect((await call("POST", `/applied-changes/${change.id}/undo`, jordan)).statusCode).toBe(200);
    expectProblem(await call("GET", `/items/${change.entityId}`, sam), 404, "not_found");
  });

  it("asks for the missing piece instead of guessing, and stays queued", async () => {
    const id = await queue({
      matchType: "new",
      fields: fields({ frequency: null, dueDate: "2026-11-25", renewalDate: null }),
    });
    const res = expectProblem(
      await call("POST", `/review-items/${id}/confirm`, sam),
      400,
      "validation_failed",
    );
    expect(JSON.stringify(res)).toContain("fields.frequency");
    expect((await call("GET", `/review-items/${id}`, sam)).json().state).toBe("queued");
    // The user supplies it through edit.
    const edited = await call("POST", `/review-items/${id}/edit`, sam, { fields: { frequency: "monthly" } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().item).toMatchObject({ state: "edited", fields: { frequency: "monthly" } });
  });

  it("a matched item that was deleted since is a 409", async () => {
    const item = await createBill({ name: "Renters (gone)" });
    const id = await queue({ matchItemId: item.id });
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `${base()}/items/${item.id}`,
          headers: { ...sam, ...key() },
        })
      ).statusCode,
    ).toBe(204);
    expectProblem(await call("POST", `/review-items/${id}/confirm`, sam), 409, "conflict");
  });
});

describe("edit and ignore", () => {
  it("edit applies the corrected values, keeps them on the item and marks it edited", async () => {
    const item = await createBill({ name: "Renters (edit)" });
    const id = await queue({ matchItemId: item.id });
    const res = await call("POST", `/review-items/${id}/edit`, sam, {
      fields: { amountDueCents: 16500, renewalDate: "2027-01-10" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().item).toMatchObject({
      state: "edited",
      fields: { amountDueCents: 16500, renewalDate: "2027-01-10", providerName: "Northgate Home Insurance" },
    });
    const now = await getItem(item.id);
    expect(now.amountCents).toBe(16500);
    expect(now.renewal?.coverageEnd).toBe("2027-01-10");
  });

  it("edit validates the corrected fields (cents are integers, last 4 only)", async () => {
    const item = await createBill({ name: "Renters (edit bad)" });
    const id = await queue({ matchItemId: item.id });
    expectProblem(
      await call("POST", `/review-items/${id}/edit`, sam, { fields: { amountDueCents: 10.5 } }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("POST", `/review-items/${id}/edit`, sam, { fields: { accountLast4: "123456789" } }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("POST", `/review-items/${id}/edit`, sam, { fields: {} }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("POST", `/review-items/${id}/edit`, sam, { fields: { emailBody: "x" } }),
      400,
      "validation_failed",
    );
    expect((await getItem(item.id)).amountCents).toBe(14900);
  });

  it("ignore changes nothing", async () => {
    const item = await createBill({ name: "Renters (ignore)" });
    const id = await queue({ matchItemId: item.id });
    const res = await call("POST", `/review-items/${id}/ignore`, jordan);
    expect(res.json()).toMatchObject({
      item: { state: "ignored", decidedBy: JORDAN() },
      appliedChange: null,
    });
    expect((await getItem(item.id)).amountCents).toBe(14900);
  });

  it("an auto_applied or expired item cannot be decided", async () => {
    const id = await queue({ state: "expired" });
    expectProblem(await call("POST", `/review-items/${id}/confirm`, sam), 409, "conflict");
  });
});

describe("undo", () => {
  async function confirmed(name: string) {
    const item = await createBill({ name });
    const id = await queue({ matchItemId: item.id });
    const res = await call("POST", `/review-items/${id}/confirm`, sam);
    return { item, change: res.json().appliedChange as { id: string; undoUntil: string } };
  }

  it("restores the prior values within undo_until, once", async () => {
    const { item, change } = await confirmed("Renters (undo)");
    expect((await getItem(item.id)).amountCents).toBe(16800);
    t.setNow("2026-11-20T09:00:00Z");
    const res = await call("POST", `/applied-changes/${change.id}/undo`, sam);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      undoneBy: SAM(),
      undoneAt: "2026-11-20T09:00:00Z",
      undoable: false,
    });
    const back = await getItem(item.id);
    expect(back.amountCents).toBe(14900);
    expect(back.version).toBeGreaterThan(item.version);
    expectProblem(await call("POST", `/applied-changes/${change.id}/undo`, sam), 409, "conflict");
    t.setNow(NOW);
  });

  it("is allowed at undo_until and rejected after it", async () => {
    const { item, change } = await confirmed("Renters (window)");
    t.setNow("2026-12-03T16:00:01Z");
    const late = expectProblem(
      await call("POST", `/applied-changes/${change.id}/undo`, sam),
      409,
      "conflict",
    );
    expect(late.detail).toContain("30-day window");
    expect((await getItem(item.id)).amountCents).toBe(16800);
    const listed = (await call("GET", "/applied-changes?limit=100", sam)).json().data as {
      id: string;
      undoable: boolean;
    }[];
    expect(listed.find((c) => c.id === change.id)?.undoable).toBe(false);
    t.setNow("2026-12-03T16:00:00Z");
    expect((await call("POST", `/applied-changes/${change.id}/undo`, sam)).statusCode).toBe(200);
    expect((await getItem(item.id)).amountCents).toBe(14900);
    t.setNow(NOW);
  });

  it("refuses when the item was changed again since (it would overwrite a newer edit)", async () => {
    const { item, change } = await confirmed("Renters (changed)");
    const patched = await t.app.inject({
      method: "PATCH",
      url: `${base()}/items/${item.id}`,
      headers: { ...sam, "if-match": `"${(await getItem(item.id)).version}"` },
      payload: { amountCents: 17000 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expectProblem(await call("POST", `/applied-changes/${change.id}/undo`, sam), 409, "conflict");
    expect((await getItem(item.id)).amountCents).toBe(17000);
  });

  it("restores through the items service: a partner-owned item keeps its approval guard", async () => {
    // Undoing a created item is a delete; Jordan's new item cannot be removed by Sam without approval.
    const id = await queue({
      matchType: "new",
      fields: fields({
        providerName: "Jordan Gym",
        category: "membership",
        insuranceType: null,
        amountDueCents: 3000,
        previousAmountCents: null,
        renewalDate: null,
        dueDate: "2026-11-28",
        frequency: "monthly",
        accountLast4: null,
      }),
    });
    const made = (await call("POST", `/review-items/${id}/confirm`, jordan)).json().appliedChange;
    expectProblem(await call("POST", `/applied-changes/${made.id}/undo`, sam), 403, "approval_required");
    expect((await getItem(made.entityId)).amountCents).toBe(3000);
  });

  it("unknown or other households' changes are not found", async () => {
    expectProblem(await call("POST", `/applied-changes/${randomUUID()}/undo`, sam), 404, "not_found");
  });
});

describe("sender history helper", () => {
  it("knows whether a sender was already confirmed for an item", async () => {
    const item = await createBill({ name: "Renters (sender)" });
    const check = (domain: string) =>
      t.db.withHouseholdTx({ userId: SAM(), householdId: seeded.householdId }, (tx) =>
        hasPriorDecidedFromSender(tx, seeded.householdId, item.id, domain),
      );
    expect(await check("northgate-insurance.example")).toBe(false);
    const id = await queue({ matchItemId: item.id });
    expect(await check("northgate-insurance.example")).toBe(false); // queued is not decided
    await call("POST", `/review-items/${id}/confirm`, sam);
    expect(await check("Northgate-Insurance.example")).toBe(true);
    expect(await check("other.example")).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("a stranger sees nothing and decides nothing", async () => {
    const item = await createBill({ name: "Renters (stranger)" });
    const id = await queue({ matchItemId: item.id });
    const h = stranger.headers;
    expect((await call("GET", "/review-items", h)).json().data).toEqual([]);
    expect((await call("GET", "/applied-changes", h)).json().data).toEqual([]);
    expectProblem(await call("GET", `/review-items/${id}`, h), 404, "not_found");
    for (const action of ["confirm", "ignore"]) {
      expectProblem(await call("POST", `/review-items/${id}/${action}`, h), 404, "not_found");
    }
    expectProblem(
      await call("POST", `/review-items/${id}/edit`, h, { fields: { amountDueCents: 1 } }),
      404,
      "not_found",
    );
    expect((await call("GET", `/review-items/${id}`, sam)).json().state).toBe("queued");
  });
});
