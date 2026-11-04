// CSV import (WP-16; BACKEND_PLAN §5.2 imports, §7.7, §8.2). The browser uploads the file straight to object
// storage with the presigned request, then asks us to process it. We never return raw rows: only counts, the header
// row (so the person can say which column is which) and the status.
import { z } from "zod";
import { Cents, IsoDate, Timestamp, Uuid } from "../common";

/** Same ceiling in the presigned request, the API check and the worker (BACKEND_PLAN §7.7). */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export const IMPORT_STATUSES = ["uploaded", "needs_mapping", "processing", "done", "failed"] as const;
export const IMPORT_ERROR_CODES = [
  "too_large",
  "empty",
  "no_rows",
  "too_many_rows",
  "too_many_columns",
  "bad_encoding",
  "parse_failed",
  "missing_file",
  "bad_mapping",
] as const;

const Column = z.string().min(1).max(100);

/** Which column of the file is which. Either `amount`, or `debit` and/or `credit`. Names are the file's headers. */
const mappingShape = z.strictObject({
  date: Column,
  description: Column,
  amount: Column.optional(),
  debit: Column.optional(),
  credit: Column.optional(),
  balance: Column.optional(),
  account: Column.optional(),
  /** For a single amount column: which sign is money going out. Debit/credit columns ignore it. */
  amountSign: z.enum(["outflow_negative", "outflow_positive"]).default("outflow_negative"),
});

export const ColumnMapping = mappingShape
  .refine((m) => m.amount !== undefined || m.debit !== undefined || m.credit !== undefined, {
    message: "Choose the amount column, or the debit and credit columns.",
    path: ["amount"],
  })
  .refine((m) => m.amount === undefined || (m.debit === undefined && m.credit === undefined), {
    message: "Choose either one amount column or debit and credit columns, not both.",
    path: ["amount"],
  })
  .meta({ id: "ImportColumnMapping" });
export type ColumnMapping = z.infer<typeof ColumnMapping>;

/** `POST …/imports`: declares the file so the presigned request can be limited to it. */
export const CreateImport = z
  .object({
    filename: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1).max(IMPORT_MAX_BYTES),
    contentType: z.literal("text/csv").default("text/csv"),
  })
  .meta({ id: "CreateImport" });
export type CreateImport = z.infer<typeof CreateImport>;

export const ImportBalance = z.object({ cents: Cents, on: IsoDate }).meta({ id: "ImportBalance" });

export const Import = z
  .object({
    id: Uuid,
    filename: z.string(),
    status: z.enum(IMPORT_STATUSES),
    /** The file's header row, once read. Present while the import needs a mapping. */
    columns: z.array(z.string()).nullable(),
    /** A starting point for the mapping screen, from common header names. Never applied without a person. */
    suggestedMapping: mappingShape.partial().nullable(),
    mapping: ColumnMapping.nullable(),
    rowCount: z.number().int().nullable(),
    addedCount: z.number().int().nullable(),
    duplicateCount: z.number().int().nullable(),
    rejectedCount: z.number().int().nullable(),
    /** Recurring items found. */
    detectedCount: z.number().int().nullable(),
    /** How many of them were sent to the review queue (the rest already match an item we track). */
    queuedCount: z.number().int().nullable(),
    /** The balance after the latest transaction, when the file has a balance column. Ask the person to confirm it. */
    latestBalance: ImportBalance.nullable(),
    error: z.enum(IMPORT_ERROR_CODES).nullable(),
    createdAt: Timestamp,
    processedAt: Timestamp.nullable(),
  })
  .meta({ id: "Import" });
export type Import = z.infer<typeof Import>;

/** How to upload: a presigned request. Secrets live in the URL, so this response is never stored for replay. */
export const ImportUpload = z
  .object({
    method: z.enum(["PUT", "POST"]),
    url: z.url(),
    /** Headers the upload must send (for example the content type). */
    headers: z.record(z.string(), z.string()),
    /** Form fields to send first, for a presigned POST. Empty for a PUT. */
    fields: z.record(z.string(), z.string()),
    expiresAt: Timestamp,
    maxBytes: z.number().int(),
  })
  .meta({ id: "ImportUpload" });

export const CreatedImport = z.object({ import: Import, upload: ImportUpload }).meta({ id: "CreatedImport" });
export type CreatedImport = z.infer<typeof CreatedImport>;

export const ImportParams = z.object({ hid: Uuid, id: Uuid });
