// Job `imports.process` (BACKEND_PLAN §7.7, ARCHITECTURE §4.6), singleton per import:
//   1 read the file, decode, parse (limits enforced), fingerprint the header row
//   2 no mapping for this fingerprint: `needs_mapping`, the file stays until a person chooses
//   3 normalize rows, dedupe into `transactions` (a re-import adds nothing)
//   4 detect recurring items over the household's last 13 months and queue them for review (source csv)
//   5 delete the file (`purged_at`)
// Idempotent: a repeat finds the import `done` and only finishes the clean-up. Nothing here logs a row, an amount
// or a description (hard rule 8); failures carry a fixed code in `imports.error`.
import { z } from "zod";
import { ExtractedFields } from "@mp/contracts";
import { householdToday, type Tx, type WorkerDb } from "@mp/db";
import {
  CsvError,
  MAX_CSV_BYTES,
  candidateFields,
  checkMapping,
  decodeCsvBytes,
  detectRecurring,
  headerFingerprint,
  matchExistingItem,
  normalizeRows,
  parseCsv,
  windowStart,
  type ColumnMapping,
  type RecurringCandidate,
} from "@mp/detection";
import { decideExtraction } from "@mp/review-rules";
import * as repo from "./repo";
import type { ImportFileStore } from "./storage";

export const IMPORTS_PROCESS_QUEUE = "imports.process";
export const IMPORTS_PROCESS_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
} as const;

export const ImportsProcessJob = z.object({ householdId: z.uuid(), importId: z.uuid() });
export type ImportsProcessJob = z.infer<typeof ImportsProcessJob>;

/** One running job per import. */
export function importsProcessSingletonKey(job: ImportsProcessJob): string {
  return `${IMPORTS_PROCESS_QUEUE}:${job.importId}`;
}

export interface ImportsProcessDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
  store: () => ImportFileStore;
}

export type ImportsProcessResult =
  | { outcome: "skipped" }
  | { outcome: "needs_mapping" }
  | { outcome: "failed"; error: string }
  | { outcome: "done"; added: number; duplicates: number; detected: number; queued: number };

const ColumnMappingShape = z.object({
  date: z.string(),
  description: z.string(),
  amount: z.string().optional(),
  debit: z.string().optional(),
  credit: z.string().optional(),
  balance: z.string().optional(),
  account: z.string().optional(),
  amountSign: z.enum(["outflow_negative", "outflow_positive"]).default("outflow_negative"),
});

function asMapping(value: unknown): ColumnMapping | null {
  const parsed = ColumnMappingShape.safeParse(value);
  if (!parsed.success) return null;
  const { amountSign, ...rest } = parsed.data;
  // exactOptionalPropertyTypes: drop undefined keys.
  const mapping: ColumnMapping = { date: rest.date, description: rest.description, amountSign };
  for (const key of ["amount", "debit", "credit", "balance", "account"] as const) {
    const v = rest[key];
    if (v !== undefined) mapping[key] = v;
  }
  return mapping;
}

/** Cleans up the stored file once the import is finished (done or failed). Safe to repeat. */
async function purgeFile(
  deps: ImportsProcessDeps,
  job: ImportsProcessJob,
  key: string | null,
): Promise<void> {
  if (key === null) return;
  await deps.store().delete(key);
  await deps.db.withJobTx(job.householdId, (tx) => repo.markPurged(tx, job.householdId, job.importId));
}

async function fail(
  deps: ImportsProcessDeps,
  job: ImportsProcessJob,
  key: string | null,
  error: string,
  extra: { fingerprint?: string; columns?: string[] } = {},
): Promise<ImportsProcessResult> {
  await deps.db.withJobTx(job.householdId, (tx) =>
    repo.markFailed(tx, job.householdId, job.importId, error, extra),
  );
  await purgeFile(deps, job, key);
  return { outcome: "failed", error };
}

export async function handleImportsProcess(
  deps: ImportsProcessDeps,
  data: unknown,
): Promise<ImportsProcessResult> {
  const job = ImportsProcessJob.parse(data);
  const current = await deps.db.withJobTx(job.householdId, async (tx) => {
    const row = await repo.loadImport(tx, job.householdId, job.importId);
    const timezone = await repo.householdTimezone(tx, job.householdId);
    return { row, timezone };
  });
  const { row, timezone } = current;
  if (!row || !timezone) return { outcome: "skipped" };
  // A repeat after a crash: the data is in, only the file is left to delete.
  if ((row.status === "done" || row.status === "failed") && row.s3Key !== null) {
    await purgeFile(deps, job, row.s3Key);
    return { outcome: "skipped" };
  }
  if (row.status !== "processing" || row.s3Key === null) return { outcome: "skipped" };
  const key = row.s3Key;

  const bytes = await deps.store().get(key);
  if (bytes === null) return fail(deps, job, null, "missing_file");

  let parsed;
  try {
    if (bytes.byteLength > MAX_CSV_BYTES) throw new CsvError("too_large");
    parsed = parseCsv(decodeCsvBytes(bytes));
  } catch (err) {
    return fail(deps, job, key, err instanceof CsvError ? err.code : "parse_failed");
  }
  const fingerprint = headerFingerprint(parsed.headers);

  // A mapping a person chose for this import wins; otherwise the one saved for this header row.
  const chosen = asMapping(row.mapping);
  const mapping =
    chosen ??
    (await deps.db.withJobTx(job.householdId, async (tx) =>
      asMapping(await repo.savedMapping(tx, job.householdId, fingerprint)),
    ));
  if (mapping === null) {
    await deps.db.withJobTx(job.householdId, (tx) =>
      repo.markNeedsMapping(tx, job.householdId, job.importId, {
        fingerprint,
        columns: parsed.headers,
        rowCount: parsed.rows.length,
      }),
    );
    return { outcome: "needs_mapping" };
  }
  if (checkMapping(mapping, parsed.headers) !== null) {
    return fail(deps, job, key, "bad_mapping", { fingerprint, columns: parsed.headers });
  }

  const normalized = normalizeRows(parsed.rows, mapping);
  if (normalized.transactions.length === 0) {
    return fail(deps, job, key, "no_rows", { fingerprint, columns: parsed.headers });
  }
  const today = householdToday(deps.now(), timezone);

  const result = await deps.db.withJobTx(job.householdId, async (tx) => {
    const added = await repo.insertTransactions(tx, job.householdId, job.importId, normalized.transactions);
    const stats = await detectAndQueue(tx, job, today);
    await repo.markDone(tx, job.householdId, job.importId, {
      fingerprint,
      columns: parsed.headers,
      rowCount: parsed.rows.length,
      added,
      duplicates: normalized.transactions.length - added,
      rejected: normalized.rejected,
      detected: stats.detected,
      queued: stats.queued,
      balance: normalized.latestBalance,
    });
    return { added, duplicates: normalized.transactions.length - added, ...stats };
  });
  await purgeFile(deps, job, key);
  return { outcome: "done", ...result };
}

/**
 * Detect over everything stored for the household, match to the items we track, and queue what a person should
 * look at. An item we already track with the same fixed amount is counted but not queued, and a candidate that
 * already has a review row (queued or decided) is not queued again.
 */
async function detectAndQueue(
  tx: Tx,
  job: ImportsProcessJob,
  today: string,
): Promise<{ detected: number; queued: number }> {
  const history = await repo.transactionsSince(tx, job.householdId, windowStart(today));
  const candidates = detectRecurring(history, today);
  const items = await repo.existingItems(tx, job.householdId);
  const reviewed = await repo.csvKeysAlreadyReviewed(tx, job.householdId);
  let queued = 0;
  for (const c of candidates) {
    if (reviewed.has(c.key)) continue;
    const match = matchExistingItem(c, items);
    if (match?.type === "duplicate") continue;
    const fields = ExtractedFields.parse(candidateFields(c));
    await repo.insertQueueRow(tx, {
      householdId: job.householdId,
      importId: job.importId,
      fields,
      evidence: [{ field: "providerName", quote: (c.latestDescription || c.displayName).slice(0, 140) }],
      checks: checksFor(c, match ? items.find((i) => i.id === match.itemId) : undefined, fields),
      matchItemId: match?.itemId ?? null,
      matchType: match ? "update" : "new",
    });
    queued += 1;
  }
  return { detected: candidates.length, queued };
}

/**
 * The detection facts the review card may show, plus the auto-apply verdict. A CSV match goes through the same
 * policy as email (`decideExtraction`) with honest signals: an uploaded file has no authenticated sender and no
 * provider-domain match, so the policy sends every CSV change to a person (Q-142).
 */
function checksFor(
  c: RecurringCandidate,
  matched: { amountType: "fixed" | "estimated" | "statement"; amountCents: number | null } | undefined,
  fields: ExtractedFields,
): object {
  const decision = decideExtraction({
    outcome: { status: "ok", validation: { ok: true, advisoryFields: [] } },
    authentication: { dmarcAligned: false },
    injectionSuspected: false,
    domainMatch: false,
    matchedItemConfirmed: matched !== undefined,
    senderFirstSeen: true,
    autoApplyEnabled: true,
    fields,
    item: matched
      ? {
          amountType: matched.amountType,
          expectedAmountCents: matched.amountCents,
          expectedDate: c.nextExpected,
          renewal: null,
        }
      : null,
  });
  return {
    csv: {
      key: c.key,
      direction: c.direction,
      kind: c.kind,
      cadence: c.cadence,
      schedule: c.schedule,
      amountType: c.amountType,
      typicalAmountCents: c.typicalAmountCents,
      occurrences: c.occurrences,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
    },
    // CSV rows are always reviewed by a person, whatever the policy says (it cannot say auto_apply here).
    decision: {
      action: "review",
      reasons: decision.action === "review" ? decision.reasons : ["csv_never_auto"],
    },
  };
}
