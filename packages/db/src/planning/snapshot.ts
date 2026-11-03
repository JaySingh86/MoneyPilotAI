// calc_snapshots (BACKEND_PLAN §5.2, §7.2): the engine result for one input, deduplicated by
// (household, inputs_hash, engine_version). The same input read twice yields the same snapshot id.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { computeFullPlan, ENGINE_VERSION, type EngineInput, type FullPlanResult } from "@mp/engine";
import type { Tx } from "../tx";
import { loadEngineInput, type LoadOptions, type PlanNotReadyReason } from "./engine-input";

/** JSON with object keys sorted, so equal inputs always serialize to the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 of the canonical engine input (32 bytes). */
export function inputsHash(input: EngineInput): Buffer {
  return createHash("sha256").update(canonicalJson(input)).digest();
}

/**
 * Inserts the snapshot unless the same input and engine version already has one, and returns its id.
 * Runs as mp_api or mp_worker with INSERT and SELECT only, so the row can never be changed afterwards.
 */
export async function storeSnapshot(
  tx: Tx,
  householdId: string,
  input: EngineInput,
  result: FullPlanResult,
): Promise<{ id: string; created: boolean }> {
  const hash = inputsHash(input);
  const inserted = await tx.execute<{ id: string }>(sql`insert into calc_snapshots
      (household_id, engine_version, as_of, inputs_hash, result)
    values (${householdId}, ${result.engineVersion}, ${input.asOf}::date, ${hash}, ${JSON.stringify(result)}::jsonb)
    on conflict (household_id, inputs_hash, engine_version) do nothing returning id`);
  const created = inserted.rows[0];
  if (created) return { id: created.id, created: true };
  // A concurrent writer's row is invisible to the statement above; a new statement sees it.
  const existing = await tx.execute<{ id: string }>(sql`select id from calc_snapshots
    where household_id = ${householdId} and inputs_hash = ${hash} and engine_version = ${ENGINE_VERSION}`);
  const row = existing.rows[0];
  if (!row) throw new Error("calc snapshot vanished after a conflicting insert");
  return { id: row.id, created: false };
}

export type RecomputeResult =
  | { status: "computed"; snapshotId: string; created: boolean; asOf: string }
  | { status: "not_ready"; reason: PlanNotReadyReason }
  | { status: "no_household" };

/** The `plan.recompute` job body for one household (BACKEND_PLAN §9): load, compute, store. Idempotent. */
export async function recomputePlan(
  tx: Tx,
  householdId: string,
  options: LoadOptions,
): Promise<RecomputeResult> {
  const loaded = await loadEngineInput(tx, householdId, options);
  if (!loaded) return { status: "no_household" };
  if (!loaded.ready) return { status: "not_ready", reason: loaded.reason };
  const result = computeFullPlan(loaded.input);
  const stored = await storeSnapshot(tx, householdId, loaded.input, result);
  return { status: "computed", snapshotId: stored.id, created: stored.created, asOf: loaded.input.asOf };
}
