// Drizzle mirror of migrations/202611091300_wp21_email-connections.sql. The SQL migration is the source of truth;
// test/integration/schema-mirror.test.ts fails if the two drift apart.
import { boolean, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { households, users } from "./identity";
import { bytea } from "./types";

export const EMAIL_PROVIDERS = ["gmail", "outlook"] as const;
export const EMAIL_CONNECTION_STATUSES = ["active", "paused", "error", "revoked"] as const;
export const EMAIL_CONNECTION_ERRORS = [
  "auth_expired",
  "provider_error",
  "rate_limited",
  "watch_failed",
  "watch_expiring",
  "revoked_by_provider",
] as const;
export const EMAIL_BACKFILL_STATUSES = ["pending", "running", "done", "failed"] as const;
export const EMAIL_MESSAGE_STAGES = [
  "discovered",
  "prefiltered_out",
  "irrelevant",
  "extracted",
  "failed",
  "quarantined",
] as const;

const householdId = () =>
  uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" });

export const emailConnections = pgTable("email_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  provider: text("provider", { enum: EMAIL_PROVIDERS }).notNull(),
  addressMasked: text("address_masked").notNull(),
  addressHash: bytea("address_hash").notNull(),
  scopes: text("scopes").array().notNull(),
  tokenCiphertext: bytea("token_ciphertext"),
  tokenDekWrapped: bytea("token_dek_wrapped"),
  tokenKeyId: text("token_key_id"),
  status: text("status", { enum: EMAIL_CONNECTION_STATUSES }).notNull().default("active"),
  syncCursor: text("sync_cursor"),
  watchRef: text("watch_ref"),
  watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
  pushReceivedAt: timestamp("push_received_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error", { enum: EMAIL_CONNECTION_ERRORS }),
  backfillMonths: integer("backfill_months").notNull().default(13),
  backfillStatus: text("backfill_status", { enum: EMAIL_BACKFILL_STATUSES }).notNull().default("pending"),
  backfillCursor: text("backfill_cursor"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const emailMessages = pgTable("email_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdId(),
  connectionId: uuid("connection_id"),
  channel: text("channel", { enum: ["gmail", "outlook", "forward"] }).notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  fromDomain: text("from_domain").notNull(),
  subject: text("subject"),
  stage: text("stage", { enum: EMAIL_MESSAGE_STAGES }).notNull(),
  truncated: boolean("truncated").notNull().default(false),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** WP-22: how discovery found it. The first 13-month backfill goes through the Batch API; new mail is a direct call. */
  intake: text("intake", { enum: ["discover", "backfill"] })
    .notNull()
    .default("discover"),
  /** WP-22: the Batch API batch the message is waiting in. */
  aiBatchId: text("ai_batch_id"),
  /** WP-22 cost caps: when the message was charged to the household's daily extraction budget, and whether its sender was new. */
  extractChargedAt: timestamp("extract_charged_at", { withTimezone: true }),
  extractNewSender: boolean("extract_new_sender").notNull().default(false),
  /** WP-22: how often the message was released from a batch unprocessed; the second release fails it. */
  extractReleases: smallint("extract_releases").notNull().default(0),
});

export const emailOauthStates = pgTable("email_oauth_states", {
  stateHash: bytea("state_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: EMAIL_PROVIDERS }).notNull(),
  returnTo: text("return_to", { enum: ["/imports", "/setup"] }).notNull(),
  codeVerifier: text("code_verifier").notNull(),
  browserHash: bytea("browser_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
