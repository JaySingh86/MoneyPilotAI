// Drizzle mirror of migrations/202610271502_wp03_platform.sql (source of truth: the SQL).
import {
  bigserial,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./types";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    householdId: uuid("household_id"),
    actorUserId: uuid("actor_user_id"),
    actorType: text("actor_type", { enum: ["user", "system", "support"] }).notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set by app_purge_audit_events() when the household no longer exists (BACKEND_PLAN §7.11). */
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
  },
  (t) => [index("audit_events_household_idx").on(t.householdId, t.createdAt.desc())],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    userId: uuid("user_id").notNull(),
    requestHash: bytea("request_hash").notNull(),
    response: jsonb("response"),
    statusCode: integer("status_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] }), index("idempotency_keys_created_idx").on(t.createdAt)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

// Drizzle mirror of migrations/202611031300_wp12_calc-snapshots.sql (source of truth: the SQL).
export const calcSnapshots = pgTable("calc_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  engineVersion: text("engine_version").notNull(),
  asOf: date("as_of", { mode: "string" }).notNull(),
  inputsHash: bytea("inputs_hash").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
