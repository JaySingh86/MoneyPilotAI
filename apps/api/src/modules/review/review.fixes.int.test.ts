// Fix round for WP-14 (security M1 to M4, lows L1 to L7, sender rules): behavior against a real Postgres.
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
let householdId: string;
let samId: string;
let jordanId: string;
let sam: Record<string, string>;
let jordan: Record<string, string>;
let stranger: { id: string; headers: Record<string, string> };
const NOW = "2026-11-03T16:00:00Z";
const base = () => `/v1/households/${householdId}`;

beforeAll(async () => {
  t = await createReviewTestApi(NOW);
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  const profile = (label: string) => ({
    authSubject: `review-fix|${label}|${randomUUID()}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    firstName: label,
  });
  const creator = await ensureUser(t.db, profile("sam"));
  const partner = await ensureUser(t.db, profile("jordan"));
  householdId = randomUUID();
  await createHousehold(t.db, creator, {
    id: householdId,
    name: "Review fix household",
    timezone: "America/New_York",
    forwardingToken: `fix-${householdId.slice(0, 8)}`,
  });
  await acceptInvite(t.db, partner, (await inviteMember(t.db, creator, householdId, partner.email)).token);
  samId = creator.id;
  jordanId = partner.id;
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
  extra: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url: `${base()}${url}`,
    headers: method === "GET" ? headers : { ...headers, ...key(), ...extra },
    ...(payload ? { payload } : {}),
  });

async function createBill(over: Record<string, unknown> = {}) {
  const res = await call("POST", "/items", sam, {
    direction: "outflow",
    kind: "insurance",
    category: "insurance",
    name: `Item ${randomUUID().slice(0, 6)}`,
    providerName: "Northgate Home Insurance",
    providerDomain: "northgate-insurance.example",
    amountType: "fixed",
    amountCents: 14900,
    schedule: { type: "yearly", dtstart: "2026-01-09" },
    ownerType: "member",
    ownerUserId: samId,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number };
}

async function queue(opts: {
  matchItemId?: string | null;
  matchType?: "new" | "update" | "decision" | "duplicate";
  fields?: ExtractedFields;
  rawFields?: unknown;
  fromDomain?: string;
  subject?: string;
  source?: "email" | "csv";
}): Promise<string> {
  const id = randomUUID();
  const f = opts.rawFields ?? opts.fields ?? fields();
  await worker.withJobTx(householdId, (tx) =>
    tx.execute(sql`insert into extracted_items
        (id, household_id, source, extractor_version, fields, evidence, checks, message_meta, match_item_id, match_type)
      values (${id}, ${householdId}, ${opts.source ?? "email"}, 'extraction.v1', ${JSON.stringify(f)}::jsonb,
        ${JSON.stringify([{ field: "amountDueCents", quote: "Your renewal premium is $168.00" }])}::jsonb, '{"ok":true}'::jsonb,
        ${JSON.stringify({ fromDomain: opts.fromDomain ?? "northgate-insurance.example", subject: opts.subject ?? "Renewal", receivedAt: "2026-10-24T14:02:00Z" })}::jsonb,
        ${opts.matchItemId ?? null}, ${opts.matchType ?? "update"})`),
  );
  return id;
}

const getItem = async (id: string) =>
  (await call("GET", `/items/${id}`, sam)).json() as {
    amountCents: number | null;
    version: number;
    name: string;
    source: string;
    providerDomain: string | null;
    renewal: unknown;
  };

const newItemFields = (over: Partial<ExtractedFields> = {}) =>
  fields({
    providerName: "Pawsure Pet Insurance",
    insuranceType: "pet",
    amountDueCents: 4200,
    previousAmountCents: null,
    renewalDate: null,
    dueDate: "2026-11-25",
    frequency: "monthly",
    accountLast4: null,
    ...over,
  });

describe("subject masking (M1)", () => {
  it("masks long digit runs and card patterns in the subject", async () => {
    await queue({ subject: "Statement for account 123456789 and card 4111 1111 1111 1111" });
    const rows = (await call("GET", "/review-items?limit=100", sam)).json().data as {
      message: { subject: string };
    }[];
    const subjects = rows.map((r) => r.message.subject);
    expect(subjects).toContain("Statement for account •••6789 and card •••1111");
    expect(subjects.join(" ")).not.toContain("123456789");
  });
});

describe("provider domain (M3)", () => {
  it("is set on a new item only from the edit body, never from the sender", async () => {
    const auto = await queue({ matchType: "new", fields: newItemFields(), fromDomain: "pawsure.example" });
    const a = await call("POST", `/review-items/${auto}/confirm`, sam);
    expect(await getItem(a.json().appliedChange.entityId)).toMatchObject({ providerDomain: null });

    const confirmed = await queue({
      matchType: "new",
      fields: newItemFields(),
      fromDomain: "pawsure.example",
    });
    const e = await call("POST", `/review-items/${confirmed}/edit`, sam, {
      fields: { providerDomain: "pawsure.example" },
    });
    expect(e.statusCode, e.body).toBe(200);
    expect(await getItem(e.json().appliedChange.entityId)).toMatchObject({
      providerDomain: "pawsure.example",
      source: "email",
    });
    const bad = await queue({ matchType: "new", fields: newItemFields() });
    expectProblem(
      await call("POST", `/review-items/${bad}/edit`, sam, { fields: { providerDomain: "Not A Host" } }),
      400,
      "validation_failed",
    );
  });

  it("only decisions that produced an applied change count as a prior decision", async () => {
    const item = await createBill({ name: "Sender history" });
    const seen = (domain: string) =>
      t.db.withHouseholdTx({ userId: samId, householdId }, (tx) =>
        hasPriorDecidedFromSender(tx, householdId, item.id, domain),
      );
    const dup = await queue({ matchItemId: item.id, matchType: "duplicate", fromDomain: "dup.example" });
    await call("POST", `/review-items/${dup}/confirm`, sam);
    const noop = await queue({
      matchItemId: item.id,
      fromDomain: "noop.example",
      fields: fields({ amountDueCents: 14900, previousAmountCents: null, renewalDate: null }),
    });
    const noopRes = await call("POST", `/review-items/${noop}/confirm`, sam);
    expect(noopRes.json().appliedChange).toBeNull();
    const real = await queue({ matchItemId: item.id, fromDomain: "real.example" });
    await call("POST", `/review-items/${real}/confirm`, sam);
    expect(await seen("dup.example")).toBe(false);
    expect(await seen("noop.example")).toBe(false);
    expect(await seen("real.example")).toBe(true);
  });
});

describe("source of items created from a review (Q-124)", () => {
  it("a csv review creates a csv item", async () => {
    const id = await queue({ matchType: "new", fields: newItemFields(), source: "csv" });
    const res = await call("POST", `/review-items/${id}/confirm`, sam);
    expect(res.json().appliedChange).toMatchObject({ origin: "csv" });
    expect(await getItem(res.json().appliedChange.entityId)).toMatchObject({ source: "csv" });
  });

  it("clients cannot name a source on the items API", async () => {
    expectProblem(
      await call("POST", "/items", sam, {
        direction: "outflow",
        kind: "bill",
        category: "other",
        name: "Sneaky",
        amountType: "fixed",
        amountCents: 1,
        schedule: { type: "monthly_day", day: 1, dtstart: "2026-11-01" },
        ownerType: "both",
        source: "email",
      }),
      400,
      "validation_failed",
    );
  });
});

describe("no matching bill (L2)", () => {
  async function estimated() {
    return createBill({
      kind: "bill",
      category: "utilities",
      name: `Electric ${randomUUID().slice(0, 4)}`,
      amountType: "estimated",
      amountCents: 10000,
      schedule: { type: "monthly_day", day: 20, dtstart: "2026-11-20" },
    });
  }
  const bill = (over: Partial<ExtractedFields>) =>
    fields({
      docType: "bill",
      category: "utilities",
      insuranceType: null,
      amountDueCents: 12345,
      previousAmountCents: null,
      renewalDate: null,
      dueDate: "2026-11-20",
      ...over,
    });

  it("is a 409 when no upcoming bill is due on that date, and stays queued", async () => {
    const item = await estimated();
    const id = await queue({ matchItemId: item.id, fields: bill({ dueDate: "2026-12-31" }) });
    expectProblem(await call("POST", `/review-items/${id}/confirm`, sam), 409, "conflict");
    expect((await call("GET", `/review-items/${id}`, sam)).json().state).toBe("queued");
  });

  it("asks for a due date when the notice has none", async () => {
    const item = await estimated();
    const id = await queue({ matchItemId: item.id, fields: bill({ dueDate: null }) });
    expectProblem(await call("POST", `/review-items/${id}/confirm`, sam), 400, "validation_failed");
  });

  it("an actual amount undone leaves no history point behind (Q-122)", async () => {
    const item = await estimated();
    const id = await queue({ matchItemId: item.id, fields: bill({}) });
    const res = await call("POST", `/review-items/${id}/confirm`, sam);
    expect(res.statusCode, res.body).toBe(200);
    const change = res.json().appliedChange;
    const history = async () =>
      (await call("GET", `/items/${item.id}/history`, sam)).json().data as unknown[];
    expect(await history()).toHaveLength(1);
    expect((await call("POST", `/applied-changes/${change.id}/undo`, sam)).statusCode).toBe(200);
    expect(await history()).toHaveLength(0);
  });
});

describe("renewal added then undone (Q-122)", () => {
  it("removes the renewal record again when the item had none", async () => {
    const item = await createBill({ name: "No renewal yet" });
    const id = await queue({ matchItemId: item.id });
    const change = (await call("POST", `/review-items/${id}/confirm`, sam)).json().appliedChange;
    expect((await getItem(item.id)).renewal).not.toBeNull();
    expect((await call("POST", `/applied-changes/${change.id}/undo`, sam)).statusCode).toBe(200);
    expect((await getItem(item.id)).renewal).toBeNull();
  });

  it("the partner-owned guard applies to deleting a renewal", async () => {
    const item = await createBill({ name: "Jordan's", ownerUserId: jordanId });
    const id = await queue({ matchItemId: item.id });
    const change = (await call("POST", `/review-items/${id}/confirm`, jordan)).json().appliedChange;
    expectProblem(await call("POST", `/applied-changes/${change.id}/undo`, sam), 403, "approval_required");
    expect((await getItem(item.id)).renewal).not.toBeNull();
  });
});

describe("undoing a created item (M4)", () => {
  async function created() {
    const id = await queue({ matchType: "new", fields: newItemFields() });
    const change = (await call("POST", `/review-items/${id}/confirm`, sam)).json().appliedChange;
    return change as { id: string; entityId: string };
  }

  it("is refused when the item was edited since", async () => {
    const change = await created();
    const item = await getItem(change.entityId);
    const patched = await t.app.inject({
      method: "PATCH",
      url: `${base()}/items/${change.entityId}`,
      headers: { ...sam, "if-match": `"${item.version}"` },
      payload: { name: "Renamed" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expectProblem(await call("POST", `/applied-changes/${change.id}/undo`, sam), 409, "conflict");
    expect((await getItem(change.entityId)).name).toBe("Renamed");
  });

  it("is refused when a bill of it was paid", async () => {
    const change = await created();
    const occ = (
      await call("GET", `/occurrences?from=2026-11-01&to=2026-12-31&itemId=${change.entityId}`, sam)
    ).json().data as { id: string; version: number }[];
    expect(occ.length).toBeGreaterThan(0);
    const paid = await t.app.inject({
      method: "PATCH",
      url: `${base()}/occurrences/${occ[0]?.id}`,
      headers: { ...sam, "if-match": `"${occ[0]?.version}"` },
      payload: { status: "paid", paidOn: "2026-11-25" },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expectProblem(await call("POST", `/applied-changes/${change.id}/undo`, sam), 409, "conflict");
  });

  it("is blocked for the other member's item, and leaves no proposal behind (WP-13)", async () => {
    const id = await queue({ matchType: "new", fields: newItemFields() });
    const change = (await call("POST", `/review-items/${id}/confirm`, jordan)).json().appliedChange as {
      id: string;
      entityId: string;
    };
    const read = await t.app.inject({
      method: "GET",
      url: `${base()}/items/${change.entityId}`,
      headers: sam,
    });
    expect(read.json().ownerUserId).toBe(jordanId);
    expectProblem(await call("POST", `/applied-changes/${change.id}/undo`, sam), 403, "approval_required");
    expect(
      (await t.app.inject({ method: "GET", url: `${base()}/items/${change.entityId}`, headers: sam }))
        .statusCode,
    ).toBe(200);
    const proposals = (await call("GET", "/proposals?status=pending", sam)).json().data as {
      payload: { itemId?: string };
    }[];
    expect(proposals.some((p) => p.payload.itemId === change.entityId)).toBe(false);
  });

  it("works when nothing changed", async () => {
    const change = await created();
    expect((await call("POST", `/applied-changes/${change.id}/undo`, sam)).statusCode).toBe(200);
  });
});

describe("unreadable rows (L5)", () => {
  it("a bad row is skipped in lists, cannot be confirmed, and can be ignored", async () => {
    const bad = await queue({ rawFields: { docType: "bill" } });
    const good = await queue({});
    const list = await call("GET", "/review-items?limit=100", sam);
    expect(list.statusCode).toBe(200);
    const ids = (list.json().data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(good);
    expect(ids).not.toContain(bad);
    expectProblem(await call("GET", `/review-items/${bad}`, sam), 409, "conflict");
    expectProblem(await call("POST", `/review-items/${bad}/confirm`, sam), 409, "conflict");
    const ignored = await call("POST", `/review-items/${bad}/ignore`, sam);
    expect(ignored.statusCode, ignored.body).toBe(200);
    expect(ignored.json().item.state).toBe("ignored");
  });
});

describe("edit keeps the original (L7)", () => {
  it("marks the evidence stale and stores the original fields", async () => {
    const item = await createBill({ name: "Edit original" });
    const original = fields();
    const id = await queue({ matchItemId: item.id, fields: original });
    const res = await call("POST", `/review-items/${id}/edit`, sam, { fields: { amountDueCents: 16500 } });
    expect(res.json().item).toMatchObject({ state: "edited", evidenceStale: true });
    const confirmedId = await queue({ matchItemId: item.id, fields: fields({ amountDueCents: 17000 }) });
    expect((await call("POST", `/review-items/${confirmedId}/confirm`, sam)).json().item.evidenceStale).toBe(
      false,
    );
    const stored = await t.admin((c) =>
      c.query<{ original_fields: Record<string, unknown>; fields: Record<string, unknown> }>(
        "select original_fields, fields from extracted_items where id = $1",
        [id],
      ),
    );
    expect(stored.rows[0]?.original_fields).toEqual(original);
    expect(stored.rows[0]?.fields).toMatchObject({ amountDueCents: 16500 });
  });
});

describe("decided lists sort by decision time", () => {
  it("lists the most recently decided first", async () => {
    const first = await queue({});
    const second = await queue({});
    t.setNow("2026-11-04T10:00:00Z");
    await call("POST", `/review-items/${second}/ignore`, sam);
    t.setNow("2026-11-04T11:00:00Z");
    await call("POST", `/review-items/${first}/ignore`, sam);
    t.setNow(NOW);
    const res = await call("GET", "/review-items?state=ignored&limit=2", sam);
    expect((res.json().data as { id: string }[]).map((r) => r.id)).toEqual([first, second]);
    const next = await call(
      "GET",
      `/review-items?state=ignored&limit=100&cursor=${encodeURIComponent(res.json().nextCursor)}`,
      sam,
    );
    const rest = (next.json().data as { id: string }[]).map((r) => r.id);
    expect(rest).not.toContain(first);
    expect(rest).not.toContain(second);
  });
});

describe("sender rules (§8.2)", () => {
  it("creates, changes and lists household rules", async () => {
    const create = await call("POST", "/sender-rules", sam, { domain: "promo.example", rule: "ignore" });
    expect(create.statusCode, create.body).toBe(201);
    expect(create.json()).toMatchObject({ domain: "promo.example", rule: "ignore", createdBy: samId });
    const change = await call("POST", "/sender-rules", jordan, {
      domain: "promo.example",
      rule: "watch",
      categoryHint: "subscription",
    });
    expect(change.statusCode).toBe(200);
    expect(change.json()).toMatchObject({
      id: create.json().id,
      rule: "watch",
      categoryHint: "subscription",
    });
    const list = (await call("GET", "/sender-rules", sam)).json().data as { domain: string }[];
    expect(list.filter((r) => r.domain === "promo.example")).toHaveLength(1);
  });

  it("validates the domain and is closed to non-members", async () => {
    expectProblem(
      await call("POST", "/sender-rules", sam, { domain: "Not A Host", rule: "watch" }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("POST", "/sender-rules", sam, { domain: "x.example", rule: "mute" }),
      400,
      "validation_failed",
    );
    expect((await call("GET", "/sender-rules", stranger.headers)).json().data).toEqual([]);
    expectProblem(
      await call("POST", "/sender-rules", stranger.headers, { domain: "intruder.example", rule: "ignore" }),
      403,
      "forbidden",
    );
  });
});
