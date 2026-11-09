// WP-22 rows for the RLS world: one model-run record (written by the worker, as the pipeline does). Gives the
// cross-household tests a victim in `ai_runs`.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createWorkerDb } from "../../src/tx";

export interface PipelineWorldRows {
  aiRunId: string;
}

export async function seedPipelineWorld(householdId: string): Promise<PipelineWorldRows> {
  const aiRunId = randomUUID();
  const worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  try {
    await worker.withJobTx(householdId, (tx) =>
      tx.execute(sql`insert into ai_runs (id, household_id, purpose, model_id, prompt_version, status,
          input_tokens, output_tokens, cost_micros)
        values (${aiRunId}, ${householdId}, 'extract', 'claude-opus-5-5', 'extract.v1', 'ok', 1500, 220, 10400)`),
    );
  } finally {
    await worker.close();
  }
  return { aiRunId };
}
