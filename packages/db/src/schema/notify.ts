// Drizzle mirror of migrations/202611041500_wp15_notifications.sql. The SQL migration is the source of truth;
// test/integration/schema-mirror.test.ts fails if the two drift apart.
import { bigserial, boolean, date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { households, users } from "./identity";

export const NOTIFICATION_KINDS = [
  "reminder",
  "review",
  "proposal",
  "task",
  "digest",
  "security",
  "system",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const reminderRules = pgTable("reminder_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  itemId: uuid("item_id"),
  offsetsDays: integer("offsets_days").array().notNull().default([3, 0]),
  channels: text("channels", { enum: ["email", "push"] })
    .array()
    .notNull()
    .default(["email"]),
  alsoNotifyPartner: boolean("also_notify_partner").notNull().default(false),
});

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  mutedKinds: text("muted_kinds").array().notNull().default([]),
  emailSuppressedAt: timestamp("email_suppressed_at", { withTimezone: true }),
  emailSuppressedReason: text("email_suppressed_reason", { enum: ["hard_bounce", "complaint"] }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  deepLink: text("deep_link"),
  sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
  attemptAt: timestamp("attempt_at", { withTimezone: true }),
  status: text("status", { enum: ["scheduled", "sent", "failed", "cancelled"] })
    .notNull()
    .default("scheduled"),
  readAt: timestamp("read_at", { withTimezone: true }),
  itemId: uuid("item_id"),
  scheduledOn: date("scheduled_on", { mode: "string" }),
  offsetDays: integer("offset_days"),
  dueOn: date("due_on", { mode: "string" }),
  claimAttempts: integer("claim_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  notificationId: uuid("notification_id").notNull(),
  channel: text("channel", { enum: ["email", "push"] }).notNull(),
  providerMessageId: text("provider_message_id"),
  status: text("status", {
    enum: ["queued", "sent", "delivered", "bounced", "complained", "failed"],
  }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sendQuotaEvents = pgTable("send_quota_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["invite"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
