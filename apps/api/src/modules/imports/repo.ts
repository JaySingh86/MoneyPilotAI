// SQL for CSV imports. Always called inside `withHouseholdTx`.
import { sql } from "drizzle-orm";
import type { Tx } from "@mp/db";

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

export interface ImportRow {
  id: string;
  filename: string;
  status: "uploaded" | "needs_mapping" | "processing" | "done" | "failed";
  s3Key: string | null;
  fingerprint: string | null;
  columns: string[] | null;
  mapping: unknown;
  rowCount: number | null;
  addedCount: number | null;
  duplicateCount: number | null;
  rejectedCount: number | null;
  detectedCount: number | null;
  queuedCount: number | null;
  latestBalanceCents: number | null;
  latestBalanceOn: string | null;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
}

const COLUMNS = sql`id, filename, status, s3_key, fingerprint, columns, mapping, row_count, added_count, duplicate_count,
  rejected_count, detected_count, queued_count, latest_balance_cents, latest_balance_on::text as latest_balance_on, error,
  ${iso("created_at")} as created_at, ${iso("processed_at")} as processed_at`;

function toRow(r: Row): ImportRow {
  return {
    id: str(r.id),
    filename: str(r.filename),
    status: r.status as ImportRow["status"],
    s3Key: strOrNull(r.s3_key),
    fingerprint: strOrNull(r.fingerprint),
    columns: Array.isArray(r.columns) ? (r.columns as unknown[]).map(String) : null,
    mapping: r.mapping ?? null,
    rowCount: numOrNull(r.row_count),
    addedCount: numOrNull(r.added_count),
    duplicateCount: numOrNull(r.duplicate_count),
    rejectedCount: numOrNull(r.rejected_count),
    detectedCount: numOrNull(r.detected_count),
    queuedCount: numOrNull(r.queued_count),
    latestBalanceCents: numOrNull(r.latest_balance_cents),
    latestBalanceOn: strOrNull(r.latest_balance_on),
    error: strOrNull(r.error),
    createdAt: str(r.created_at),
    processedAt: strOrNull(r.processed_at),
  };
}

export async function insertImport(
  tx: Tx,
  input: {
    id: string;
    householdId: string;
    userId: string;
    s3Key: string;
    filename: string;
    sizeBytes: number;
  },
): Promise<void> {
  await tx.execute(sql`insert into imports (id, household_id, uploaded_by, s3_key, filename, size_bytes, status)
    values (${input.id}, ${input.householdId}, ${input.userId}, ${input.s3Key}, ${input.filename}, ${input.sizeBytes}, 'uploaded')`);
}

export async function getImport(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<ImportRow | null> {
  const res = await tx.execute(
    sql`select ${COLUMNS} from imports where id = ${id} and household_id = ${householdId} ${lock ? sql`for update` : sql``}`,
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/** Imports created by this household in the last 24 hours (a daily cap, so a loop cannot fill the bucket). */
export async function countRecentImports(tx: Tx, householdId: string): Promise<number> {
  const res = await tx.execute(
    sql`select count(*)::int as n from imports where household_id = ${householdId} and created_at > now() - interval '1 day'`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function queueForProcessing(tx: Tx, householdId: string, id: string): Promise<void> {
  await tx.execute(
    sql`update imports set status = 'processing' where id = ${id} and household_id = ${householdId}`,
  );
}

/** Saves the mapping on the import and queues it, in one statement the guard trigger allows. */
export async function chooseMapping(
  tx: Tx,
  householdId: string,
  id: string,
  mapping: unknown,
): Promise<void> {
  await tx.execute(sql`update imports set mapping = ${JSON.stringify(mapping)}::jsonb, status = 'processing'
    where id = ${id} and household_id = ${householdId}`);
}

/** One saved mapping per header fingerprint, replaced when a member chooses again. */
export async function saveFingerprintMapping(
  tx: Tx,
  input: { householdId: string; userId: string; fingerprint: string; mapping: unknown },
): Promise<void> {
  await tx.execute(sql`insert into import_mappings (household_id, fingerprint, mapping, created_by)
    values (${input.householdId}, ${input.fingerprint}, ${JSON.stringify(input.mapping)}::jsonb, ${input.userId})
    on conflict (household_id, fingerprint)
    do update set mapping = excluded.mapping, created_by = excluded.created_by, updated_at = now()`);
}

export async function audit(
  tx: Tx,
  householdId: string,
  userId: string,
  action: string,
  id: string,
): Promise<void> {
  await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (${householdId}, ${userId}, 'user', ${action}, 'import', ${id})`);
}
