// SQL for the import job. Always called inside `withJobTx` (RLS scopes every statement to the job's household).
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { transactions, type Tx } from "@mp/db";
import type { ExistingItemRef, NormalizedTransaction } from "@mp/detection";
import { dedupeKey } from "@mp/detection";

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface ImportJobRow {
  id: string;
  status: "uploaded" | "needs_mapping" | "processing" | "done" | "failed";
  s3Key: string | null;
  mapping: unknown;
  purged: boolean;
}

export async function loadImport(tx: Tx, householdId: string, id: string): Promise<ImportJobRow | null> {
  const res = await tx.execute(
    sql`select id, status, s3_key, mapping, purged_at is not null as purged from imports where id = ${id} and household_id = ${householdId} for update`,
  );
  const r: Row | undefined = res.rows[0];
  return r
    ? {
        id: str(r.id),
        status: r.status as ImportJobRow["status"],
        s3Key: strOrNull(r.s3_key),
        mapping: r.mapping ?? null,
        purged: r.purged === true,
      }
    : null;
}

export async function householdTimezone(tx: Tx, householdId: string): Promise<string | null> {
  const res = await tx.execute(sql`select timezone from households where id = ${householdId}`);
  return strOrNull(res.rows[0]?.timezone);
}

export async function savedMapping(tx: Tx, householdId: string, fingerprint: string): Promise<unknown> {
  const res = await tx.execute(
    sql`select mapping from import_mappings where household_id = ${householdId} and fingerprint = ${fingerprint}`,
  );
  return res.rows[0]?.mapping ?? null;
}

export async function markNeedsMapping(
  tx: Tx,
  householdId: string,
  id: string,
  input: { fingerprint: string; columns: string[]; rowCount: number },
): Promise<void> {
  await tx.execute(sql`update imports set status = 'needs_mapping', fingerprint = ${input.fingerprint},
      columns = ${JSON.stringify(input.columns)}::jsonb, row_count = ${input.rowCount}, error = null
    where id = ${id} and household_id = ${householdId}`);
}

export async function markFailed(
  tx: Tx,
  householdId: string,
  id: string,
  error: string,
  extra: { fingerprint?: string; columns?: string[] } = {},
): Promise<void> {
  await tx.execute(sql`update imports set status = 'failed', error = ${error}, processed_at = now(),
      fingerprint = coalesce(${extra.fingerprint ?? null}, fingerprint),
      columns = coalesce(${extra.columns ? JSON.stringify(extra.columns) : null}::jsonb, columns)
    where id = ${id} and household_id = ${householdId}`);
}

export function dedupeHash(householdId: string, t: NormalizedTransaction): Buffer {
  return createHash("sha256")
    .update(`${householdId}|${dedupeKey(t)}`)
    .digest();
}

const CHUNK = 1000;

/** Inserts the rows; a row whose hash already exists is skipped. Returns how many were new. */
export async function insertTransactions(
  tx: Tx,
  householdId: string,
  importId: string,
  rows: readonly NormalizedTransaction[],
): Promise<number> {
  let added = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((t) => ({
      householdId,
      importId,
      postedOn: t.postedOn,
      description: t.description,
      merchantNorm: t.merchantNorm,
      amountCents: t.amountCents,
      accountLabel: t.accountLast4,
      dedupeHash: dedupeHash(householdId, t),
    }));
    const inserted = await tx
      .insert(transactions)
      .values(chunk)
      .onConflictDoNothing({ target: [transactions.householdId, transactions.dedupeHash] })
      .returning({ id: transactions.id });
    added += inserted.length;
  }
  return added;
}

/** Every stored transaction on or after `since` (all imports of the household), for detection. */
export async function transactionsSince(
  tx: Tx,
  householdId: string,
  since: string,
): Promise<{ postedOn: string; merchantNorm: string; amountCents: number; description: string }[]> {
  const res = await tx.execute(
    sql`select posted_on::text as posted_on, merchant_norm, amount_cents, description from transactions
      where household_id = ${householdId} and posted_on >= ${since} order by posted_on, id`,
  );
  return res.rows.map((r) => ({
    postedOn: str(r.posted_on),
    merchantNorm: str(r.merchant_norm),
    amountCents: Number(r.amount_cents),
    description: str(r.description),
  }));
}

export async function existingItems(tx: Tx, householdId: string): Promise<ExistingItemRef[]> {
  const res = await tx.execute(
    sql`select id, name, provider_name, direction, amount_type, amount_cents from recurring_items
      where household_id = ${householdId} and deleted_at is null and status <> 'ended'`,
  );
  return res.rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    providerName: strOrNull(r.provider_name),
    direction: r.direction as ExistingItemRef["direction"],
    amountType: r.amount_type as ExistingItemRef["amountType"],
    amountCents: r.amount_cents === null || r.amount_cents === undefined ? null : Number(r.amount_cents),
  }));
}

/** Candidate keys that already have a CSV review item (queued or decided): a re-import must not queue them again. */
export async function csvKeysAlreadyReviewed(tx: Tx, householdId: string): Promise<Set<string>> {
  const res = await tx.execute(
    sql`select checks #>> '{csv,key}' as key from extracted_items
      where household_id = ${householdId} and source = 'csv' and state <> 'expired'`,
  );
  return new Set(res.rows.map((r) => strOrNull(r.key)).filter((k): k is string => k !== null));
}

export interface QueueRow {
  householdId: string;
  importId: string;
  fields: object;
  evidence: object[];
  checks: object;
  matchItemId: string | null;
  matchType: "new" | "update";
}

/**
 * The only writer of CSV review rows (WP-14: only the worker inserts queue rows). Every column of `fields` is
 * written; `message_meta` is null (a CSV has no sender or subject); the row is always queued.
 */
export async function insertQueueRow(tx: Tx, row: QueueRow): Promise<void> {
  await tx.execute(sql`insert into extracted_items
      (household_id, source, import_id, extractor_version, model_id, fields, evidence, checks, message_meta,
       match_item_id, match_type, state)
    values (${row.householdId}, 'csv', ${row.importId}, 'csv.v1', null, ${JSON.stringify(row.fields)}::jsonb,
      ${JSON.stringify(row.evidence)}::jsonb, ${JSON.stringify(row.checks)}::jsonb, null,
      ${row.matchItemId}, ${row.matchType}, 'queued')`);
}

export async function markDone(
  tx: Tx,
  householdId: string,
  id: string,
  r: {
    fingerprint: string;
    columns: string[];
    rowCount: number;
    added: number;
    duplicates: number;
    rejected: number;
    detected: number;
    queued: number;
    balance: { cents: number; on: string } | null;
  },
): Promise<void> {
  await tx.execute(sql`update imports set status = 'done', error = null, processed_at = now(),
      fingerprint = ${r.fingerprint}, columns = ${JSON.stringify(r.columns)}::jsonb, row_count = ${r.rowCount},
      added_count = ${r.added}, duplicate_count = ${r.duplicates}, rejected_count = ${r.rejected},
      detected_count = ${r.detected}, queued_count = ${r.queued},
      latest_balance_cents = ${r.balance?.cents ?? null}, latest_balance_on = ${r.balance?.on ?? null}
    where id = ${id} and household_id = ${householdId}`);
}

export async function markPurged(tx: Tx, householdId: string, id: string): Promise<void> {
  await tx.execute(
    sql`update imports set s3_key = null, purged_at = now() where id = ${id} and household_id = ${householdId}`,
  );
}

/** Whether an import row exists for the id, its status, and whether it still points at a stored file. */
export async function importFileState(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<{ status: string; hasKey: boolean } | null> {
  const res = await tx.execute(
    sql`select status, s3_key is not null as has_key from imports where id = ${id} and household_id = ${householdId}`,
  );
  const row = res.rows[0];
  return row ? { status: str(row.status), hasKey: row.has_key === true } : null;
}

/** Imports waiting for the worker, and finished ones whose file is still stored. */
export async function pendingImportIds(tx: Tx, householdId: string): Promise<string[]> {
  const res = await tx.execute(
    sql`select id from imports where household_id = ${householdId}
      and ((status = 'processing') or (status in ('done','failed') and s3_key is not null))
    order by created_at limit 50`,
  );
  return res.rows.map((r) => str(r.id));
}

export async function purgeOldTransactions(tx: Tx, householdId: string, before: string): Promise<number> {
  const res = await tx.execute(
    sql`delete from transactions where household_id = ${householdId} and posted_on < ${before}`,
  );
  return res.rowCount ?? 0;
}
