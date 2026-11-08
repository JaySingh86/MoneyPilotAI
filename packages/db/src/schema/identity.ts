// Drizzle mirror of migrations/202610271501_wp03_identity.sql. The SQL migration is the source of
// truth; test/integration/schema-mirror.test.ts fails if the two drift apart.
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bytea, citext } from "./types";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  authSubject: text("auth_subject").notNull().unique(),
  email: citext("email").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  timezone: text("timezone").notNull().default("America/New_York"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  cushionCents: bigint("cushion_cents", { mode: "number" }).notNull().default(50000),
  primaryIncomeItemId: uuid("primary_income_item_id"),
  plan: text("plan", { enum: ["free", "family_plus"] })
    .notNull()
    .default("free"),
  forwardingToken: text("forwarding_token").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  deletionScheduledFor: timestamp("deletion_scheduled_for", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    colorRole: text("color_role", { enum: ["partnerA", "partnerB"] }).notNull(),
    isCreator: boolean("is_creator").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.userId] }),
    uniqueIndex("household_members_color_uq")
      .on(t.householdId, t.colorRole)
      .where(sql`left_at is null`),
    index("household_members_user_idx")
      .on(t.userId)
      .where(sql`left_at is null`),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    firstName: text("first_name"),
    tokenHash: bytea("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_household_idx").on(t.householdId), index("invites_email_idx").on(t.email)],
);
