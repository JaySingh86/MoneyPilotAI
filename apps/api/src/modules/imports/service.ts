// CSV import service (BACKEND_PLAN §7.7, ARCHITECTURE §4.6): declare a file and get a presigned upload, ask for
// processing, choose a column mapping. The parsing, dedupe and detection run in the worker (WP-16 job
// `imports.process`); this module never reads file content.
import { randomUUID } from "node:crypto";
import {
  AppError,
  ColumnMapping,
  IMPORT_MAX_BYTES,
  type CreateImport,
  type CreatedImport,
  type Import,
} from "@mp/contracts";
import type { ApiContext, ApiDb, Tx } from "@mp/db";
import { checkMapping, cleanText, suggestMapping } from "@mp/detection";
import { mapDbError } from "../items/service";
import * as repo from "./repo";
import { importKey, type ImportStorage } from "./storage";

export interface Actor {
  ctx: ApiContext;
  userId: string;
  householdId: string;
}

/** Asks the worker to process an import. Best effort: the worker's sweep also picks up `processing` imports. */
export interface ImportQueue {
  enqueueProcess(householdId: string, importId: string): Promise<void>;
}

export interface ImportsDeps {
  db: ApiDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
  storage: () => ImportStorage;
  queue?: ImportQueue;
}

/** Uploads a household may start per day. */
export const DAILY_IMPORT_LIMIT = 30;
const UPLOAD_URL_SECONDS = 15 * 60;

const notFound = () => new AppError("not_found", 404, "Import not found.");

async function inTx<T>(deps: ImportsDeps, a: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(a.ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

/** The bare file name, sanitized: no path, no control characters, no formula start, at most 120 characters. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = cleanText(base, 120);
  return cleaned === "" || cleaned === "'" ? "import.csv" : cleaned;
}

export function toImport(row: repo.ImportRow): Import {
  const mapping = ColumnMapping.safeParse(row.mapping);
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    columns: row.columns,
    suggestedMapping:
      row.status === "needs_mapping" && row.columns ? (suggestMapping(row.columns) as never) : null,
    mapping: mapping.success ? mapping.data : null,
    rowCount: row.rowCount,
    addedCount: row.addedCount,
    duplicateCount: row.duplicateCount,
    rejectedCount: row.rejectedCount,
    detectedCount: row.detectedCount,
    queuedCount: row.queuedCount,
    latestBalance:
      row.latestBalanceCents !== null && row.latestBalanceOn !== null
        ? { cents: row.latestBalanceCents, on: row.latestBalanceOn }
        : null,
    error: row.error as Import["error"],
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}

export async function createImport(deps: ImportsDeps, a: Actor, body: CreateImport): Promise<CreatedImport> {
  const id = randomUUID();
  const key = importKey(a.householdId, id);
  const row = await inTx(deps, a, async (tx) => {
    if ((await repo.countRecentImports(tx, a.householdId)) >= DAILY_IMPORT_LIMIT) {
      throw new AppError("rate_limited", 429, "Too many files today. Try again tomorrow.", {
        headers: { "retry-after": "3600" },
      });
    }
    await repo.insertImport(tx, {
      id,
      householdId: a.householdId,
      userId: a.userId,
      s3Key: key,
      filename: safeFilename(body.filename),
      sizeBytes: body.sizeBytes,
    });
    await repo.audit(tx, a.householdId, a.userId, "import.created", id);
    const created = await repo.getImport(tx, a.householdId, id);
    if (!created) throw notFound();
    return created;
  });
  const upload = await deps.storage().createUpload({
    key,
    contentType: "text/csv",
    maxBytes: Math.min(body.sizeBytes, IMPORT_MAX_BYTES),
    expiresInSeconds: UPLOAD_URL_SECONDS,
  });
  return {
    import: toImport(row),
    upload: { ...upload, maxBytes: Math.min(body.sizeBytes, IMPORT_MAX_BYTES) },
  };
}

export async function getImport(deps: ImportsDeps, a: Actor, id: string): Promise<Import> {
  const row = await inTx(deps, a, (tx) => repo.getImport(tx, a.householdId, id));
  if (!row) throw notFound();
  return toImport(row);
}

/** After the browser's upload: checks the object exists and is within the size limit, then queues the import. */
export async function processImport(deps: ImportsDeps, a: Actor, id: string): Promise<Import> {
  const current = await inTx(deps, a, (tx) => repo.getImport(tx, a.householdId, id));
  if (!current) throw notFound();
  // Asking twice is fine: an import that is already queued, running or finished is returned as it is.
  if (current.status !== "uploaded") {
    if (current.status === "needs_mapping") {
      throw new AppError("conflict", 409, "This file needs its columns chosen first.");
    }
    return toImport(current);
  }
  if (!current.s3Key) throw notFound();
  const head = await deps.storage().head(current.s3Key);
  if (!head) throw new AppError("validation_failed", 400, "The file has not been uploaded yet.");
  if (head.sizeBytes > IMPORT_MAX_BYTES) {
    await deps.storage().delete(current.s3Key);
    throw new AppError("payload_too_large", 413, "The file is larger than 10 MB.");
  }
  const queued = await inTx(deps, a, async (tx) => {
    await repo.queueForProcessing(tx, a.householdId, id);
    await repo.audit(tx, a.householdId, a.userId, "import.process_requested", id);
    return repo.getImport(tx, a.householdId, id);
  });
  if (!queued) throw notFound();
  await deps.queue?.enqueueProcess(a.householdId, id).catch(() => undefined);
  return toImport(queued);
}

/** The person says which column is which. Saved for every file with the same header row. */
export async function putMapping(
  deps: ImportsDeps,
  a: Actor,
  id: string,
  mapping: ColumnMapping,
): Promise<Import> {
  const result = await inTx(deps, a, async (tx) => {
    const current = await repo.getImport(tx, a.householdId, id, true);
    if (!current) throw notFound();
    if (current.status !== "needs_mapping" || !current.columns || !current.fingerprint) {
      throw new AppError("conflict", 409, "This import does not need a mapping.");
    }
    const problem = checkMapping(mapping, current.columns);
    if (problem) {
      throw new AppError("validation_failed", 400, problem, {
        fields: [{ in: "body", path: "", message: problem }],
      });
    }
    await repo.chooseMapping(tx, a.householdId, id, mapping);
    await repo.saveFingerprintMapping(tx, {
      householdId: a.householdId,
      userId: a.userId,
      fingerprint: current.fingerprint,
      mapping,
    });
    await repo.audit(tx, a.householdId, a.userId, "import.mapping_chosen", id);
    return repo.getImport(tx, a.householdId, id);
  });
  if (!result) throw notFound();
  await deps.queue?.enqueueProcess(a.householdId, id).catch(() => undefined);
  return toImport(result);
}
