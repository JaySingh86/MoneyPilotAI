// `imports.process` against a real Postgres as mp_worker (RLS scoped to the job's household), with synthetic
// 13-month bank exports built from the Rivera fixture. WP-16 acceptance: every bill and paycheck is found with the
// right amount type; re-importing adds 0 transactions; an unknown header needs a mapping and the saved mapping is
// reused for the next file.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "@mp/db";
import { createHousehold, ensureUser } from "@mp/db/testing";
import { ExtractedFields } from "@mp/contracts";
import { buildRiveraCsvs, type RiveraFixtureSlice } from "@mp/detection/testing";
import { normalizeMerchant } from "@mp/detection";
import { handleImportsProcess, type ImportsProcessDeps } from "./process";
import { handleImportsSweep, handleTransactionsPurge } from "./sweep";
import type { ImportFileStore } from "./storage";

const NOW = "2026-10-27T16:00:00Z";

class MemoryStore implements ImportFileStore {
  readonly files = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url), "utf8"),
) as RiveraFixtureSlice & { today: string };
const csvs = buildRiveraCsvs(fixture, fixture.today);

let api: ApiDb;
let worker: WorkerDb;
let admin: pg.Client;
let store: MemoryStore;
let deps: ImportsProcessDeps;

interface World {
  id: string;
  userId: string;
}
async function household(label: string): Promise<World> {
  const owner = await ensureUser(api, {
    authSubject: `imports|${label}|${randomUUID()}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    firstName: label,
    timezone: "America/New_York",
  });
  const id = randomUUID();
  await createHousehold(api, owner, {
    id,
    name: `Imports ${label}`,
    timezone: "America/New_York",
    forwardingToken: `${label}-${id.slice(0, 8)}`,
  });
  return { id, userId: owner.id };
}

/** An import the way the API leaves it after POST /process: `processing`, file stored, optional chosen mapping. */
async function queueImport(hh: World, content: string | Uint8Array, mapping?: object): Promise<string> {
  const id = randomUUID();
  const key = `imports/${hh.id}/${id}.csv`;
  store.files.set(key, typeof content === "string" ? new TextEncoder().encode(content) : content);
  await admin.query(
    `insert into imports (id, household_id, uploaded_by, s3_key, filename, size_bytes, status, mapping)
     values ($1, $2, $3, $4, 'bank.csv', 100, 'processing', $5::jsonb)`,
    [id, hh.id, hh.userId, key, mapping ? JSON.stringify(mapping) : null],
  );
  return id;
}

const run = (hh: World, importId: string) => handleImportsProcess(deps, { householdId: hh.id, importId });
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> =>
  (await admin.query(sql, params)).rows[0] as T;

const SAM_MAPPING = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  balance: "Running Bal.",
  amountSign: "outflow_negative",
};
const JORDAN_MAPPING = {
  date: "Posted",
  description: "Payee",
  debit: "Withdrawals",
  credit: "Deposits",
  account: "Account",
  amountSign: "outflow_negative",
};
const SAM_FINGERPRINT = "date|description|amount|running bal.";

beforeAll(async () => {
  api = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 2 });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 4 });
  admin = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  await admin.connect();
  store = new MemoryStore();
  deps = { db: worker, now: () => NOW, store: () => store };
}, 240_000);

afterAll(async () => {
  await admin?.end();
  await api?.close();
  await worker?.close();
});

describe("the fixture household's 13 months of CSVs", () => {
  let hh: World;
  let samFirst: string;

  it("an unknown header goes to needs_mapping and the file stays until a person chooses", async () => {
    hh = await household("rivera");
    samFirst = await queueImport(hh, csvs.sam);
    expect(await run(hh, samFirst)).toEqual({ outcome: "needs_mapping" });
    const row = await one<{
      status: string;
      fingerprint: string;
      columns: string[];
      s3_key: string | null;
      purged_at: Date | null;
    }>("select status, fingerprint, columns, s3_key, purged_at from imports where id = $1", [samFirst]);
    expect(row).toMatchObject({
      status: "needs_mapping",
      fingerprint: SAM_FINGERPRINT,
      columns: ["Date", "Description", "Amount", "Running Bal."],
    });
    expect(row.s3_key).not.toBeNull();
    expect(row.purged_at).toBeNull();
    expect(
      (
        await one<{ n: number }>("select count(*)::int as n from transactions where household_id = $1", [
          hh.id,
        ])
      ).n,
    ).toBe(0);
    // Nothing is queued while the import waits.
    expect(
      (
        await one<{ n: number }>("select count(*)::int as n from extracted_items where household_id = $1", [
          hh.id,
        ])
      ).n,
    ).toBe(0);
  });

  it("a mapping saved for the header row is applied to the next file with the same header row", async () => {
    // What PUT /imports/:id/mapping does for the person who chose it.
    await admin.query(
      `insert into import_mappings (household_id, fingerprint, mapping, created_by) values ($1, $2, $3::jsonb, $4)`,
      [hh.id, SAM_FINGERPRINT, JSON.stringify(SAM_MAPPING), hh.userId],
    );
    const next = await queueImport(hh, csvs.sam); // no mapping on the row: the saved one is found by fingerprint
    const result = await run(hh, next);
    expect(result.outcome).toBe("done");
    // The first import (waiting) is processed too once it is queued again.
    await admin.query("update imports set status = 'processing' where id = $1", [samFirst]);
    expect((await run(hh, samFirst)).outcome).toBe("done");
  });

  it("Jordan's debit/credit file with its own mapping adds its transactions", async () => {
    const jordan = await queueImport(hh, csvs.jordan, JORDAN_MAPPING);
    expect((await run(hh, jordan)).outcome).toBe("done");
    const labels = await admin.query(
      "select distinct account_label from transactions where household_id = $1 and account_label is not null",
      [hh.id],
    );
    expect(labels.rows).toEqual([{ account_label: "4821" }]);
  });

  it("detects every monthly bill, both paychecks, car insurance (6 months) and water (quarterly) with correct amount types", async () => {
    const rows = (
      await admin.query(
        "select fields, checks, match_type, state, source, message_meta, match_item_id, import_id from extracted_items where household_id = $1",
        [hh.id],
      )
    ).rows as {
      fields: Record<string, unknown>;
      checks: {
        csv: { key: string; cadence: string; amountType: string; schedule: { kind: string } };
        decision: { action: string; reasons: string[] };
      };
      match_type: string;
      state: string;
      source: string;
      message_meta: unknown;
      match_item_id: string | null;
    }[];
    expect(rows).toHaveLength(fixture.bills.length + fixture.incomes.length);
    const byKey = new Map(rows.map((r) => [r.checks.csv.key, r]));
    const norm = (id: string) => normalizeMerchant(csvs.descriptions[id] ?? "");

    for (const bill of fixture.bills) {
      const r = byKey.get(`outflow:${norm(bill.id)}`);
      expect(r, bill.id).toBeDefined();
      const expectedCadence =
        bill.schedule.type === "monthly" ? "monthly" : bill.schedule.n === 6 ? "every_6_months" : "quarterly";
      const estimated = bill.estimate !== undefined;
      expect(r?.checks.csv.cadence, bill.id).toBe(expectedCadence);
      expect(r?.checks.csv.amountType, bill.id).toBe(estimated ? "estimated" : "fixed");
      expect(r?.fields.amountDueCents ?? null, bill.id).toBe(estimated ? null : (bill.amountCents ?? null));
    }
    const sam = byKey.get(`inflow:${norm("inc-sam")}`);
    const jordan = byKey.get(`inflow:${norm("inc-jordan")}`);
    expect(sam?.checks.csv).toMatchObject({ cadence: "biweekly", amountType: "fixed" });
    expect(sam?.fields).toMatchObject({
      amountDueCents: 315000,
      category: "income",
      frequency: null,
      dueDate: "2026-11-06",
    });
    expect(jordan?.checks.csv).toMatchObject({
      cadence: "monthly",
      amountType: "fixed",
      schedule: { kind: "monthly_last_weekday" },
    });
    expect(jordan?.fields).toMatchObject({ amountDueCents: 290000, category: "income" });
    expect(byKey.get(`outflow:${norm("b-carins")}`)?.fields).toMatchObject({
      frequency: "every_6_months",
      dueDate: "2026-11-04",
      amountDueCents: 68400,
    });
    expect(byKey.get(`outflow:${norm("b-water")}`)?.fields).toMatchObject({
      frequency: "quarterly",
      dueDate: "2026-11-18",
      amountDueCents: 9600,
    });
  });

  it("writes review rows the way WP-14 requires: every key, no provider domain, no message meta, queued, csv, reviewed by a person", async () => {
    const rows = (
      await admin.query(
        "select fields, checks, evidence, match_type, state, source, message_meta, import_id, extractor_version from extracted_items where household_id = $1",
        [hh.id],
      )
    ).rows;
    for (const r of rows) {
      const parsed = ExtractedFields.parse(r.fields); // strict: all keys present, none extra
      expect(Object.keys(r.fields as object).sort()).toEqual(Object.keys(parsed).sort());
      expect(parsed.providerDomain).toBeNull();
      expect(parsed.accountLast4).toBeNull();
      expect(r).toMatchObject({
        source: "csv",
        state: "queued",
        message_meta: null,
        match_type: "new",
        extractor_version: "csv.v1",
      });
      expect(r.import_id).not.toBeNull();
      expect(r.checks.decision.action).toBe("review");
      expect(r.checks.decision.reasons).toContain("no_domain_match");
      expect(r.evidence).toHaveLength(1);
      expect(r.evidence[0].quote.length).toBeLessThanOrEqual(140);
    }
  });

  it("records counts and the balance, deletes the file and clears its key", async () => {
    const row = await one<Record<string, unknown>>(
      "select status, row_count, added_count, duplicate_count, detected_count, queued_count, latest_balance_cents, latest_balance_on::text as on, s3_key, purged_at, error from imports where id = $1",
      [samFirst],
    );
    expect(row).toMatchObject({
      status: "done",
      error: null,
      s3_key: null,
      latest_balance_cents: csvs.samBalanceCents.toString(),
    });
    expect(row.purged_at).not.toBeNull();
    expect(Number(row.added_count)).toBe(0); // the first processed file already stored these rows
    expect(Number(row.duplicate_count)).toBe(Number(row.row_count));
    expect(store.files.size).toBe(0);
  });

  it("re-importing the same file adds 0 transactions and queues nothing new", async () => {
    const before = await one<{ n: number }>(
      "select count(*)::int as n from transactions where household_id = $1",
      [hh.id],
    );
    const queuedBefore = await one<{ n: number }>(
      "select count(*)::int as n from extracted_items where household_id = $1",
      [hh.id],
    );
    const again = await queueImport(hh, csvs.sam);
    expect(await run(hh, again)).toMatchObject({ outcome: "done", added: 0, queued: 0 });
    expect(
      (
        await one<{ n: number }>("select count(*)::int as n from transactions where household_id = $1", [
          hh.id,
        ])
      ).n,
    ).toBe(before.n);
    expect(
      (
        await one<{ n: number }>("select count(*)::int as n from extracted_items where household_id = $1", [
          hh.id,
        ])
      ).n,
    ).toBe(queuedBefore.n);
    const row = await one<Record<string, unknown>>(
      "select added_count, duplicate_count, row_count from imports where id = $1",
      [again],
    );
    expect(Number(row.added_count)).toBe(0);
    expect(Number(row.duplicate_count)).toBe(Number(row.row_count));
  });

  it("processing a finished import twice does nothing (idempotent)", async () => {
    expect(await run(hh, samFirst)).toEqual({ outcome: "skipped" });
  });

  it("stores no raw file content beyond the masked, neutralised description", async () => {
    const bad = await household("hygiene");
    const csv = [
      "Date,Description,Amount",
      '10/01/2026,"=HYPERLINK(""http://evil.example"",""x"")",-5.00',
      "10/02/2026,PAYMENT TO ACCT 1234567890123456 THANKS,-7.50",
      "10/03/2026,\"+CMD|' /C calc'!A0\",-1.00",
    ].join("\n");
    const id = await queueImport(bad, csv, {
      date: "Date",
      description: "Description",
      amount: "Amount",
      amountSign: "outflow_negative",
    });
    expect((await run(bad, id)).outcome).toBe("done");
    const rows = (
      await admin.query(
        "select description, merchant_norm from transactions where household_id = $1 order by posted_on",
        [bad.id],
      )
    ).rows as {
      description: string;
      merchant_norm: string;
    }[];
    expect(rows[0]?.description.startsWith("'=")).toBe(true);
    expect(rows[1]?.description).toBe("PAYMENT TO ACCT ****3456 THANKS");
    expect(rows[2]?.description.startsWith("'+")).toBe(true);
    for (const r of rows) expect(r.merchant_norm).toMatch(/^[a-z0-9 ]+$/);
    expect(JSON.stringify(rows)).not.toContain("1234567890123456");
  });
});

describe("matching to items the household already tracks", () => {
  it("skips an identical fixed item and queues an update (with the item id) when the amount differs", async () => {
    const hh = await household("match");
    for (const [name, cents] of [
      ["Oakwood Apartments rent", 215000],
      ["Little Sprouts Daycare", 120000],
    ] as const) {
      await admin.query(
        `insert into recurring_items (household_id, direction, kind, category, name, amount_type, amount_cents, rrule, dtstart, owner_type, source)
         values ($1, 'outflow', 'bill', 'other', $2, 'fixed', $3, 'FREQ=MONTHLY;BYMONTHDAY=1', '2025-01-01', 'both', 'manual')`,
        [hh.id, name, cents],
      );
    }
    const id = await queueImport(hh, csvs.sam, SAM_MAPPING);
    const result = await run(hh, id);
    expect(result.outcome).toBe("done");
    const rows = (
      await admin.query(
        "select fields->>'providerName' as name, match_type, match_item_id from extracted_items where household_id = $1 and match_type = 'update'",
        [hh.id],
      )
    ).rows as { name: string; match_item_id: string | null }[];
    // Daycare (Sam's file) is 1,240 against the tracked 1,200: an update. Rent is identical: not queued at all.
    expect(rows.map((r) => r.name)).toEqual(["Little Sprouts Daycare"]);
    expect(rows[0]?.match_item_id).not.toBeNull();
    const rent = await admin.query(
      "select 1 from extracted_items where household_id = $1 and fields->>'providerName' = 'Oakwood Apartments Rent'",
      [hh.id],
    );
    expect(rent.rowCount).toBe(0);
  });
});

describe("failures carry a fixed code and still delete the file", () => {
  it.each([
    ["an empty file", new Uint8Array(0), "empty"],
    ["only a header", "Date,Description,Amount\n", "no_rows"],
    ["a file over 10 MB", new Uint8Array(10 * 1024 * 1024 + 1), "too_large"],
  ])("%s", async (_name, content, code) => {
    const hh = await household("fail");
    const id = await queueImport(hh, content, SAM_MAPPING);
    expect(await run(hh, id)).toEqual({ outcome: "failed", error: code });
    const row = await one<{ status: string; error: string; s3_key: string | null }>(
      "select status, error, s3_key from imports where id = $1",
      [id],
    );
    expect(row).toMatchObject({ status: "failed", error: code, s3_key: null });
    expect(store.files.size).toBe(0);
  });

  it("a mapping that names a column the file does not have fails as bad_mapping", async () => {
    const hh = await household("badmap");
    const id = await queueImport(hh, "Date,Description,Amount\n10/01/2026,x,-1\n", { ...SAM_MAPPING });
    expect(await run(hh, id)).toEqual({ outcome: "failed", error: "bad_mapping" });
  });

  it("a file that is missing from storage fails as missing_file", async () => {
    const hh = await household("missing");
    const id = await queueImport(hh, "x", SAM_MAPPING);
    store.files.clear();
    expect(await run(hh, id)).toEqual({ outcome: "failed", error: "missing_file" });
  });

  it("rows that cannot be read are counted, and a file with none readable fails as no_rows", async () => {
    const hh = await household("rejects");
    const id = await queueImport(hh, "Date,Description,Amount\nnot a date,x,1\n", {
      date: "Date",
      description: "Description",
      amount: "Amount",
      amountSign: "outflow_negative",
    });
    expect(await run(hh, id)).toEqual({ outcome: "failed", error: "no_rows" });
  });

  it("never touches another household's import", async () => {
    const a = await household("iso-a");
    const b = await household("iso-b");
    const id = await queueImport(a, csvs.sam, SAM_MAPPING);
    expect(await run(b, id)).toEqual({ outcome: "skipped" });
    expect((await one<{ status: string }>("select status from imports where id = $1", [id])).status).toBe(
      "processing",
    );
  });

  it("rejects a malformed job before touching anything", async () => {
    await expect(handleImportsProcess(deps, { householdId: "nope", importId: "x" })).rejects.toThrow();
  });
});

describe("imports.sweep and transactions.purge", () => {
  it("hands processing imports (and finished ones with a stored file) to the process queue, once each", async () => {
    const hh = await household("sweep");
    const waiting = await queueImport(hh, "x", SAM_MAPPING);
    const sent: { name: string; data: object; key: string | undefined }[] = [];
    const sender = {
      async send(name: string, data: object, options?: { singletonKey?: string }) {
        sent.push({ name, data, key: options?.singletonKey });
        return "job";
      },
    };
    await handleImportsSweep({ db: worker, sender });
    const mine = sent.filter((s) => (s.data as { householdId: string }).householdId === hh.id);
    expect(mine).toEqual([
      {
        name: "imports.process",
        data: { householdId: hh.id, importId: waiting },
        key: `imports.process:${waiting}`,
      },
    ]);
  });

  it("deletes transactions older than 13 months, keeps the rest, and only for each household's own rows", async () => {
    const hh = await household("purge");
    const other = await household("purge-other");
    for (const [h, date] of [
      [hh, "2025-09-26"],
      [hh, "2025-09-27"],
      [hh, "2026-10-01"],
      [other, "2025-01-01"],
    ] as const) {
      await admin.query(
        `insert into transactions (household_id, posted_on, description, merchant_norm, amount_cents, dedupe_hash)
         values ($1, $2, 'x', 'x', -1, $3)`,
        [h.id, date, Buffer.from(randomUUID().replace(/-/g, "").padEnd(64, "0"), "hex")],
      );
    }
    const deleted = await handleTransactionsPurge({ db: worker, now: () => NOW });
    expect(deleted).toBeGreaterThanOrEqual(2);
    const left = (
      await admin.query("select posted_on::text as d from transactions where household_id = $1 order by 1", [
        hh.id,
      ])
    ).rows.map((r) => r.d);
    // today is 2026-10-27: the window starts on 2025-09-27.
    expect(left).toEqual(["2025-09-27", "2026-10-01"]);
    expect(
      (
        await one<{ n: number }>("select count(*)::int as n from transactions where household_id = $1", [
          other.id,
        ])
      ).n,
    ).toBe(0);
  });
});
