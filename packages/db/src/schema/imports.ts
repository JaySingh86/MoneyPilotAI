// Drizzle mirror of migrations/202611041100_wp16_imports.sql. The SQL migration is the source of truth;
// test/integration/schema-mirror.test.ts fails if the two drift apart.
import { bigint, date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { households, users } from "./identity";
import { bytea } from "./types";

export const IMPORT_STATUSES = ["uploaded", "needs_mapping", "processing", "done", "failed"] as const;
export const IMPORT_ERRORS = [
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

const householdId = () =>
  uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" });

export const imports = pgTable("imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  s3Key: text("s3_key"),
  filename: text("filename").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  status: text("status", { enum: IMPORT_STATUSES }).notNull(),
  mapping: jsonb("mapping").$type<Record<string, unknown>>(),
  fingerprint: text("fingerprint"),
  columns: jsonb("columns").$type<string[]>(),
  rowCount: integer("row_count"),
  addedCount: integer("added_count"),
  duplicateCount: integer("duplicate_count"),
  rejectedCount: integer("rejected_count"),
  detectedCount: integer("detected_count"),
  queuedCount: integer("queued_count"),
  latestBalanceCents: bigint("latest_balance_cents", { mode: "number" }),
  latestBalanceOn: date("latest_balance_on", { mode: "string" }),
  error: text("error", { enum: IMPORT_ERRORS }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
});

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  importId: uuid("import_id"),
  postedOn: date("posted_on", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  merchantNorm: text("merchant_norm").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  accountLabel: text("account_label"),
  dedupeHash: bytea("dedupe_hash").notNull(),
});

export const importMappings = pgTable("import_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  fingerprint: text("fingerprint").notNull(),
  mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
