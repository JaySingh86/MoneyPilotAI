// Drizzle mirror of migrations/202611031300_wp13_goals-proposals-tasks.sql. The SQL migration is the source
// of truth; test/integration/schema-mirror.test.ts fails if the two drift apart.
import { bigint, date, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { households, users } from "./identity";
import { goals, recurringItems } from "./items";

const ownerType = pgEnum("owner_type", ["member", "both", "split"]);

const cents = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });
const householdId = () =>
  uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" });

export const goalEvents = pgTable("goal_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  goalId: uuid("goal_id")
    .notNull()
    .references(() => goals.id),
  kind: text("kind", { enum: ["deposit", "withdrawal", "adjustment"] }).notNull(),
  amountCents: cents("amount_cents").notNull(),
  occurredOn: day("occurred_on").notNull(),
  note: text("note"),
  recordedBy: uuid("recorded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  kind: text("kind", { enum: ["goal_change", "item_change", "shortfall_option", "plan_option"] }).notNull(),
  payload: jsonb("payload").notNull(),
  calcSnapshotId: uuid("calc_snapshot_id"),
  proposedBy: uuid("proposed_by")
    .notNull()
    .references(() => users.id),
  status: text("status", {
    enum: ["pending", "approved", "rejected", "expired", "applied", "superseded"],
  })
    .notNull()
    .default("pending"),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  title: text("title").notNull(),
  ownerType: ownerType("owner_type").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  dueOn: day("due_on"),
  dueHint: text("due_hint"),
  linkedItemId: uuid("linked_item_id").references(() => recurringItems.id),
  source: text("source", { enum: ["user", "engine", "email", "renewal", "setup"] }).notNull(),
  dedupeKey: text("dedupe_key"),
  autoCompleteRule: jsonb("auto_complete_rule"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: uuid("completed_by").references(() => users.id),
  completedReason: text("completed_reason"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
