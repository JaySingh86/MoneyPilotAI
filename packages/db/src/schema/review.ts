// Drizzle mirror of migrations/202611031300_wp14_review-queue.sql. The SQL migration is the source of truth;
// test/integration/schema-mirror.test.ts fails if the two drift apart.
import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { households, users } from "./identity";

export const extractedItems = pgTable("extracted_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["email", "csv"] }).notNull(),
  messageId: uuid("message_id"),
  importId: uuid("import_id"),
  extractorVersion: text("extractor_version").notNull(),
  modelId: text("model_id"),
  fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
  originalFields: jsonb("original_fields").$type<Record<string, unknown>>(),
  evidenceStale: boolean("evidence_stale").notNull().default(false),
  evidence: jsonb("evidence").$type<unknown[]>().notNull(),
  checks: jsonb("checks").$type<Record<string, unknown>>().notNull(),
  messageMeta: jsonb("message_meta").$type<Record<string, unknown>>(),
  matchItemId: uuid("match_item_id"),
  matchType: text("match_type", { enum: ["new", "update", "decision", "duplicate"] }).notNull(),
  state: text("state", { enum: ["queued", "auto_applied", "confirmed", "edited", "ignored", "expired"] })
    .notNull()
    .default("queued"),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  appliedChangeId: uuid("applied_change_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appliedChanges = pgTable("applied_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  origin: text("origin", { enum: ["email", "csv", "proposal", "user", "engine"] }).notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  appliedBy: uuid("applied_by").references(() => users.id),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  undoUntil: timestamp("undo_until", { withTimezone: true }),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => users.id),
});

export const senderRules = pgTable("sender_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Null = the global seed list. */
  householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  rule: text("rule", { enum: ["watch", "ignore"] }).notNull(),
  categoryHint: text("category_hint"),
  createdBy: uuid("created_by").references(() => users.id),
});
