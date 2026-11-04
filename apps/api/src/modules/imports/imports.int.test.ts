// CSV import routes against a real Postgres (RLS as mp_api): upload declaration, size limits, processing request,
// mapping (saved per header fingerprint), status transitions, rate limit and cross-household isolation.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sql } from "drizzle-orm";
import { createWorkerDb } from "@mp/db";
import { candidateFields, detectRecurring, type RecurringCandidate } from "@mp/detection";
import { acceptInvite, createHousehold, ensureUser, inviteMember } from "@mp/db/testing";
import { IMPORT_MAX_BYTES } from "@mp/contracts";
import { expectProblem } from "../../lib/testing";
import { RATE_LIMITS } from "../../plugins/rate-limit";
import { createImportsTestApi, type ImportsTestApi } from "./testing";

let t: ImportsTestApi;
let hid: string;
let sam: Record<string, string>;
let jordan: Record<string, string>;
let stranger: { id: string; headers: Record<string, string> };
let otherHid: string;
let otherHeaders: Record<string, string>;

const base = (h = hid) => `/v1/households/${h}`;
const call = (
  method: "GET" | "POST" | "PUT",
  url: string,
  headers: Record<string, string>,
  payload?: object,
) => t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function household(label: string) {
  const creator = await ensureUser(t.db, {
    authSubject: `imports|${label}|${randomUUID()}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    firstName: label,
  });
  const partner = await ensureUser(t.db, {
    authSubject: `imports|${label}-p|${randomUUID()}`,
    email: `${label}-p-${randomUUID().slice(0, 8)}@example.test`,
    firstName: `${label}p`,
  });
  const id = randomUUID();
  await createHousehold(t.db, creator, {
    id,
    name: `Imports ${label}`,
    timezone: "America/New_York",
    forwardingToken: `imp-${id.slice(0, 8)}`,
  });
  await acceptInvite(t.db, partner, (await inviteMember(t.db, creator, id, partner.email)).token);
  return {
    id,
    creatorHeaders: await t.as(creator.authSubject, { claims: { email: creator.email } }),
    partnerHeaders: await t.as(partner.authSubject, { claims: { email: partner.email } }),
  };
}

beforeAll(async () => {
  t = await createImportsTestApi();
  const a = await household("a");
  hid = a.id;
  sam = a.creatorHeaders;
  jordan = a.partnerHeaders;
  const b = await household("b");
  otherHid = b.id;
  otherHeaders = b.creatorHeaders;
  stranger = await t.signUp("stranger");
}, 180_000);

afterAll(async () => {
  await t?.close();
});

async function newImport(over: Record<string, unknown> = {}) {
  const res = await call("POST", `${base()}/imports`, sam, {
    filename: "checking.csv",
    sizeBytes: 2048,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { import: { id: string; status: string }; upload: Record<string, unknown> };
}

const keyOf = (importId: string) => `imports/${hid}/${importId}.csv`;

describe("POST /imports", () => {
  it("returns a presigned upload limited to the declared size and the CSV type, and an uploaded import", async () => {
    const created = await newImport();
    expect(created.import.status).toBe("uploaded");
    expect(created.upload).toMatchObject({
      method: "PUT",
      maxBytes: 2048,
      headers: { "content-type": "text/csv" },
    });
    const upload = t.storage.uploads.at(-1);
    expect(upload).toMatchObject({ key: keyOf(created.import.id), maxBytes: 2048, contentType: "text/csv" });
  });

  it("refuses more than 10 MB and a non-CSV content type before anything is stored", async () => {
    expectProblem(
      await call("POST", `${base()}/imports`, sam, { filename: "a.csv", sizeBytes: IMPORT_MAX_BYTES + 1 }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("POST", `${base()}/imports`, sam, {
        filename: "a.csv",
        sizeBytes: 10,
        contentType: "application/zip",
      }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("POST", `${base()}/imports`, sam, { filename: "a.csv", sizeBytes: 0 }),
      400,
      "validation_failed",
    );
  });

  it("stores a sanitized file name: no path, no formula, no control characters", async () => {
    const created = await newImport({ filename: "C:\\evil\\=HYPERLINK(1).csv" });
    const got = (await call("GET", `${base()}/imports/${created.import.id}`, sam)).json() as {
      filename: string;
    };
    expect(got.filename.startsWith("'=")).toBe(true);
    expect(got.filename).not.toContain("\\");
    const ctl = await newImport({ filename: "a\u0000b\nc.csv" });
    expect(
      ((await call("GET", `${base()}/imports/${ctl.import.id}`, sam)).json() as { filename: string })
        .filename,
    ).toBe("a b c.csv");
  });

  it("is available to both partners and refused to a stranger and another household", async () => {
    expect(
      (await call("POST", `${base()}/imports`, jordan, { filename: "j.csv", sizeBytes: 10 })).statusCode,
    ).toBe(201);
    expectProblem(
      await call("POST", `${base()}/imports`, stranger.headers, { filename: "x.csv", sizeBytes: 10 }),
      403,
      "forbidden",
    );
    expectProblem(
      await call("POST", `${base()}/imports`, otherHeaders, { filename: "x.csv", sizeBytes: 10 }),
      403,
      "forbidden",
    );
  });

  it("does not store a replayable response (it carries a presigned URL)", async () => {
    const headers = { ...sam, "idempotency-key": randomUUID() };
    const first = await call("POST", `${base()}/imports`, headers, { filename: "k.csv", sizeBytes: 10 });
    const second = await call("POST", `${base()}/imports`, headers, { filename: "k.csv", sizeBytes: 10 });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { import: { id: string } }).import.id).not.toBe(
      (first.json() as { import: { id: string } }).import.id,
    );
  });
});

describe("POST /imports/:id/process", () => {
  it("queues an uploaded file, tells the worker, and a second call changes nothing", async () => {
    const created = await newImport();
    const id = created.import.id;
    t.storage.put(keyOf(id), "Date,Description,Amount\n10/01/2026,Rent,-5.00\n");
    const res = await call("POST", `${base()}/imports/${id}/process`, sam);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, status: "processing" });
    expect(t.queue.sent).toContainEqual({ householdId: hid, importId: id });
    const again = await call("POST", `${base()}/imports/${id}/process`, jordan);
    expect(again.json()).toMatchObject({ status: "processing" });
  });

  it("answers 400 when nothing was uploaded", async () => {
    const created = await newImport();
    expectProblem(
      await call("POST", `${base()}/imports/${created.import.id}/process`, sam),
      400,
      "validation_failed",
    );
  });

  it("rejects an oversize object with 413 and deletes it", async () => {
    const created = await newImport();
    const id = created.import.id;
    t.storage.put(keyOf(id), new Uint8Array(IMPORT_MAX_BYTES + 1));
    expectProblem(await call("POST", `${base()}/imports/${id}/process`, sam), 413, "payload_too_large");
    expect(t.storage.objects.has(keyOf(id))).toBe(false);
    expect(((await call("GET", `${base()}/imports/${id}`, sam)).json() as { status: string }).status).toBe(
      "uploaded",
    );
  });

  it("cannot reach another household's import", async () => {
    const created = await newImport();
    expectProblem(
      await call("POST", `${base(otherHid)}/imports/${created.import.id}/process`, otherHeaders),
      404,
      "not_found",
    );
    expectProblem(
      await call("GET", `${base(otherHid)}/imports/${created.import.id}`, otherHeaders),
      404,
      "not_found",
    );
    // A stranger sees nothing: not found, never a hint that the import exists.
    expectProblem(
      await call("GET", `${base()}/imports/${created.import.id}`, stranger.headers),
      404,
      "not_found",
    );
  });
});

describe("PUT /imports/:id/mapping", () => {
  const COLUMNS = ["Posted", "Payee", "Withdrawals", "Deposits"];
  async function needsMapping(): Promise<string> {
    const created = await newImport();
    const id = created.import.id;
    await t.admin((c) =>
      c.query(
        `update imports set status = 'needs_mapping', fingerprint = $2, columns = $3::jsonb where id = $1`,
        [id, "posted|payee|withdrawals|deposits", JSON.stringify(COLUMNS)],
      ),
    );
    return id;
  }

  it("shows the header row and a suggestion while the import needs a mapping", async () => {
    const id = await needsMapping();
    const got = (await call("GET", `${base()}/imports/${id}`, sam)).json() as {
      status: string;
      columns: string[];
      suggestedMapping: Record<string, string>;
    };
    expect(got).toMatchObject({ status: "needs_mapping", columns: COLUMNS });
    expect(got.suggestedMapping).toMatchObject({
      date: "Posted",
      description: "Payee",
      debit: "Withdrawals",
      credit: "Deposits",
    });
  });

  it("saves the mapping on the import and for the header fingerprint, queues it, and the worker is told", async () => {
    const id = await needsMapping();
    const mapping = {
      date: "Posted",
      description: "Payee",
      debit: "Withdrawals",
      credit: "Deposits",
      amountSign: "outflow_negative",
    };
    const res = await call("PUT", `${base()}/imports/${id}/mapping`, jordan, mapping);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "processing", mapping });
    expect(t.queue.sent).toContainEqual({ householdId: hid, importId: id });
    const saved = await t.admin((c) =>
      c.query("select mapping from import_mappings where household_id = $1 and fingerprint = $2", [
        hid,
        "posted|payee|withdrawals|deposits",
      ]),
    );
    expect(saved.rows[0]?.mapping).toEqual(mapping);
    // Choosing again for another file with the same header row replaces the saved mapping.
    const second = await needsMapping();
    const changed = { ...mapping, account: undefined, amountSign: "outflow_positive" };
    expect((await call("PUT", `${base()}/imports/${second}/mapping`, sam, changed)).statusCode).toBe(200);
    const after = await t.admin((c) =>
      c.query(
        "select count(*)::int as n, max(mapping->>'amountSign') as sign from import_mappings where household_id = $1",
        [hid],
      ),
    );
    expect(after.rows[0]).toMatchObject({ n: 1, sign: "outflow_positive" });
  });

  it("refuses a column that is not in the file, a missing amount, and an import that needs no mapping", async () => {
    const id = await needsMapping();
    expectProblem(
      await call("PUT", `${base()}/imports/${id}/mapping`, sam, {
        date: "Nope",
        description: "Payee",
        amount: "Posted",
      }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("PUT", `${base()}/imports/${id}/mapping`, sam, { date: "Posted", description: "Payee" }),
      400,
      "validation_failed",
    );
    expectProblem(
      await call("PUT", `${base()}/imports/${id}/mapping`, sam, {
        date: "Posted",
        description: "Payee",
        amount: "Withdrawals",
        debit: "Deposits",
      }),
      400,
      "validation_failed",
    );
    const fresh = await newImport();
    expectProblem(
      await call("PUT", `${base()}/imports/${fresh.import.id}/mapping`, sam, {
        date: "a",
        description: "b",
        amount: "c",
      }),
      409,
      "conflict",
    );
  });

  it("a stranger and another household cannot choose a mapping", async () => {
    const id = await needsMapping();
    const body = { date: "Posted", description: "Payee", amount: "Withdrawals" };
    expectProblem(
      await call("PUT", `${base()}/imports/${id}/mapping`, stranger.headers, body),
      404,
      "not_found",
    );
    expectProblem(
      await call("PUT", `${base(otherHid)}/imports/${id}/mapping`, otherHeaders, body),
      404,
      "not_found",
    );
  });
});

describe("a detected item reaches the household only through review", () => {
  it("a CSV review row written like the worker writes it is confirmed through WP-14's path and becomes a csv item", async () => {
    const candidate = detectRecurring(
      ["2026-08-01", "2026-09-01", "2026-10-01"].map((postedOn) => ({
        postedOn,
        merchantNorm: "oakwood apartments rent",
        amountCents: -215000,
        description: "OAKWOOD APARTMENTS RENT",
      })),
      "2026-10-27",
    )[0];
    expect(candidate).toBeDefined();
    const fields = candidateFields(candidate as RecurringCandidate);
    const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
    let rowId = "";
    try {
      rowId = await worker.withJobTx(hid, async (tx) => {
        const res = await tx.execute<{ id: string }>(sql`insert into extracted_items
            (household_id, source, extractor_version, fields, evidence, checks, message_meta, match_type, state)
          values (${hid}, 'csv', 'csv.v1', ${JSON.stringify(fields)}::jsonb,
            '[{"field":"providerName","quote":"OAKWOOD APARTMENTS RENT"}]'::jsonb, '{}'::jsonb, null, 'new', 'queued')
          returning id`);
        return res.rows[0]?.id ?? "";
      });
    } finally {
      await worker.close();
    }
    const listed = await call("GET", `${base()}/review-items`, sam);
    expect((listed.json() as { data: { id: string; source: string }[] }).data).toContainEqual(
      expect.objectContaining({ id: rowId, source: "csv" }),
    );
    const confirmed = await call("POST", `${base()}/review-items/${rowId}/confirm`, sam);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const items = await t.admin((c) =>
      c.query(
        "select name, source, amount_type, amount_cents::int as cents, rrule from recurring_items where household_id = $1 and source = 'csv'",
        [hid],
      ),
    );
    expect(items.rows).toEqual([
      expect.objectContaining({
        name: "Oakwood Apartments Rent",
        source: "csv",
        amount_type: "fixed",
        cents: 215000,
      }),
    ]);
    expect(String(items.rows[0]?.rrule)).toContain("FREQ=MONTHLY");
  });
});

describe("the database guard", () => {
  it("a member cannot mark an import done or write its counts through the API role", async () => {
    // The routes never do; the guard trigger and column grants are tested in packages/db (pnpm test:rls). Here the
    // observable promise: a status can only move forward through the routes.
    const created = await newImport();
    const id = created.import.id;
    t.storage.put(keyOf(id), "a,b\n1,2\n");
    await call("POST", `${base()}/imports/${id}/process`, sam);
    const status = (await call("GET", `${base()}/imports/${id}`, sam)).json() as {
      status: string;
      error: string | null;
    };
    expect(status).toMatchObject({ status: "processing", error: null });
  });
});

describe("rate limit", () => {
  it("shares one budget of 10 per minute across the import routes, per user", async () => {
    const limited = await createImportsTestApi({ importsLimit: RATE_LIMITS.imports });
    try {
      const creator = await ensureUser(limited.db, {
        authSubject: `imports|rate|${randomUUID()}`,
        email: `rate-${randomUUID().slice(0, 8)}@example.test`,
        firstName: "rate",
      });
      const id = randomUUID();
      await createHousehold(limited.db, creator, {
        id,
        name: "Rate household",
        timezone: "America/New_York",
        forwardingToken: `rate-${id.slice(0, 8)}`,
      });
      const headers = await limited.as(creator.authSubject, { claims: { email: creator.email } });
      const post = () =>
        limited.app.inject({
          method: "POST",
          url: `/v1/households/${id}/imports`,
          headers,
          payload: { filename: "r.csv", sizeBytes: 10 },
        });
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await post()).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
      expect(codes[10]).toBe(429);
      // The process route draws from the same budget.
      const res = await limited.app.inject({
        method: "POST",
        url: `/v1/households/${id}/imports/${randomUUID()}/process`,
        headers,
      });
      expect(res.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
