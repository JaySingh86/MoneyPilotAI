// Drizzle mirror of migrations/202610281300_wp06_items-schedules.sql. The SQL migration is the source of
// truth; test/integration/schema-mirror.test.ts fails if the two drift apart.
// Dates are `date` columns read as `YYYY-MM-DD` strings (household-local calendar dates, hard rule 2).
import {
  bigint,
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { households, users } from "./identity";

const itemDirection = pgEnum("item_direction", ["outflow", "inflow"]);
const itemKind = pgEnum("item_kind", [
  "bill",
  "subscription",
  "insurance",
  "membership",
  "registration",
  "loan",
  "income",
  "other",
]);
const ownerType = pgEnum("owner_type", ["member", "both", "split"]);

const cents = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });
const householdId = () =>
  uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" });

export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  name: text("name").notNull(),
  type: text("type", { enum: ["savings", "planned_expense"] }).notNull(),
  targetCents: cents("target_cents").notNull(),
  savedCents: cents("saved_cents").notNull().default(0),
  monthlyCents: cents("monthly_cents").notNull().default(0),
  targetDate: day("target_date"),
  colorSlot: smallint("color_slot").notNull().default(1),
  isEmergencyFund: boolean("is_emergency_fund").notNull().default(false),
  status: text("status", { enum: ["active", "reached", "archived"] })
    .notNull()
    .default("active"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const recurringItems = pgTable("recurring_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  direction: itemDirection("direction").notNull(),
  kind: itemKind("kind").notNull(),
  category: text("category").notNull(),
  name: text("name").notNull(),
  providerName: text("provider_name"),
  providerDomain: text("provider_domain"),
  amountType: text("amount_type", { enum: ["fixed", "estimated", "statement"] }).notNull(),
  amountCents: cents("amount_cents"),
  rrule: text("rrule").notNull(),
  dtstart: day("dtstart").notNull(),
  until: day("until"),
  weekendRule: text("weekend_rule", { enum: ["none", "prev_business_day", "next_business_day"] })
    .notNull()
    .default("none"),
  ownerType: ownerType("owner_type").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  status: text("status", { enum: ["active", "paused", "ended", "pending_review"] })
    .notNull()
    .default("active"),
  source: text("source", { enum: ["manual", "csv", "email", "bank"] }).notNull(),
  accountLast4: text("account_last4"),
  paidFrom: text("paid_from", { enum: ["account", "payroll"] })
    .notNull()
    .default("account"),
  markedPossiblyUnused: boolean("marked_possibly_unused").notNull().default(false),
  subcategory: text("subcategory"),
  movable: boolean("movable"),
  onBillsPage: boolean("on_bills_page").notNull().default(true),
  notes: text("notes"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const renewalDetails = pgTable("renewal_details", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => recurringItems.id, { onDelete: "cascade" }),
  householdId: householdId(),
  autoRenews: text("auto_renews", { enum: ["yes", "no", "rolls_over"] })
    .notNull()
    .default("yes"),
  coverageStart: day("coverage_start"),
  coverageEnd: day("coverage_end"),
  cancelBy: day("cancel_by"),
  decisionBy: day("decision_by"),
  shopAroundOn: day("shop_around_on"),
  previousAmountCents: cents("previous_amount_cents"),
  priceChangedOn: day("price_changed_on"),
  documentS3Key: text("document_s3_key"),
});

export const itemAmountHistory = pgTable("item_amount_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  itemId: uuid("item_id")
    .notNull()
    .references(() => recurringItems.id, { onDelete: "cascade" }),
  occurredOn: day("occurred_on").notNull(),
  amountCents: cents("amount_cents").notNull(),
  source: text("source", { enum: ["manual", "csv", "email", "bank"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const occurrences = pgTable("occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  itemId: uuid("item_id")
    .notNull()
    .references(() => recurringItems.id, { onDelete: "cascade" }),
  scheduledOn: day("scheduled_on").notNull(),
  dueOn: day("due_on").notNull(),
  actualAmountCents: cents("actual_amount_cents"),
  status: text("status", { enum: ["scheduled", "paid", "received", "skipped"] })
    .notNull()
    .default("scheduled"),
  paidOn: day("paid_on"),
  markedBy: uuid("marked_by").references(() => users.id),
  movedBy: uuid("moved_by").references(() => users.id),
  version: integer("version").notNull().default(1),
});

export const plannedExpenses = pgTable("planned_expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  name: text("name").notNull(),
  amountCents: cents("amount_cents").notNull(),
  dueOn: day("due_on").notNull(),
  ownerType: ownerType("owner_type").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  goalId: uuid("goal_id").references(() => goals.id),
  status: text("status", { enum: ["planned", "done", "cancelled"] })
    .notNull()
    .default("planned"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const balances = pgTable("balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  label: text("label").notNull().default("Checking"),
  amountCents: cents("amount_cents").notNull(),
  asOf: day("as_of").notNull(),
  source: text("source", { enum: ["manual", "csv", "bank"] }).notNull(),
  recordedBy: uuid("recorded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
