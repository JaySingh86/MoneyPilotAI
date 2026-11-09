// Drizzle mirror of migrations/202611091500_wp22_email-pipeline.sql (model-run metering). The SQL
// migration is the source of truth; test/integration/schema-mirror.test.ts fails if the two drift apart.
import { bigint, boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { households } from "./identity";

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** The message a call was for (batch results are recorded once per message). */
    reference: text("reference"),
    purpose: text("purpose", { enum: ["extract", "explain", "ask", "eval"] }).notNull(),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    batch: boolean("batch").notNull().default(false),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    costEstimated: boolean("cost_estimated").notNull().default(false),
    stopReason: text("stop_reason"),
    latencyMs: integer("latency_ms"),
    status: text("status", { enum: ["ok", "refusal", "invalid_output", "error"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_runs_household_idx").on(t.householdId, t.createdAt.desc())],
);
