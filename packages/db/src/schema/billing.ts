// Drizzle mirror of migrations/202611041100_wp25_billing.sql. The SQL migration is the source of truth;
// test/integration/schema-mirror.test.ts fails if the two drift apart.
import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { households } from "./identity";

export const subscriptions = pgTable(
  "subscriptions",
  {
    householdId: uuid("household_id")
      .primaryKey()
      .references(() => households.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    status: text("status", { enum: ["trialing", "active", "past_due", "canceled", "expired"] }).notNull(),
    billingInterval: text("billing_interval", { enum: ["month", "year"] }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("subscriptions_provider_subscription_key").on(t.provider, t.providerSubscriptionId)],
);

export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    outcome: text("outcome", { enum: ["applied", "stale", "ignored"] }),
  },
  (t) => [unique("billing_events_provider_event_key").on(t.provider, t.eventId)],
);
