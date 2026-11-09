// Model-call metering and the AI client the worker uses (WP-22). `ai_runs` keeps metadata and token counts, never a
// prompt or an output (BACKEND_PLAN §5, §7.9). The key comes from the environment only (hard rule 12); without one the
// extraction jobs are not started and nothing reads a message for a model.
import { sql } from "drizzle-orm";
import { AiClient, createAnthropicClient, createSdkTransport, type AiRunRecord } from "@mp/ai";
import type { WorkerDb } from "@mp/db";
import type { Logger } from "@mp/observability";

/** Writes one metered run into the household's `ai_runs`. A run with no household cannot be stored and is dropped. */
export async function recordAiRun(db: WorkerDb, run: AiRunRecord): Promise<void> {
  if (run.householdId === null) return;
  await db.withJobTx(run.householdId, (tx) =>
    tx.execute(sql`insert into ai_runs
        (household_id, reference, purpose, model_id, prompt_version, batch, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_micros, cost_estimated, stop_reason, latency_ms, status)
      values (${run.householdId}, ${run.reference?.slice(0, 100) ?? null}, ${run.purpose}, ${run.modelId.slice(0, 100)},
        ${run.promptVersion.slice(0, 60)}, ${run.batch}, ${run.inputTokens}, ${run.outputTokens}, ${run.cacheReadTokens},
        ${run.cacheWriteTokens}, ${run.costMicros}, ${run.costEstimated}, ${run.stopReason?.slice(0, 60) ?? null},
        ${run.latencyMs}, ${run.status})
      -- A batch result is recorded once per message: a retried collect cannot meter it twice (N4).
      on conflict do nothing`),
  );
}

/** An `AiClient` over the real SDK that meters into `ai_runs`; null when `ANTHROPIC_API_KEY` is not set. */
export function createExtractionClient(
  env: { ANTHROPIC_API_KEY?: string | undefined },
  db: WorkerDb,
  log: Pick<Logger, "warn">,
): AiClient | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return new AiClient({
    transport: createSdkTransport(createAnthropicClient({ apiKey })),
    onRun: async (run) => {
      try {
        await recordAiRun(db, run);
      } catch (err) {
        // Metering never fails a model call (the client also swallows this); say so once per failure.
        log.warn({ err }, "could not record an ai run");
      }
    },
  });
}
