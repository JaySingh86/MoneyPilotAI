// Job `plan.recompute` (BACKEND_PLAN §7.2, §9): recomputes a household's plan and stores the snapshot, so the
// next `GET /plan` finds it and "See the math" always matches. Triggered by a change to items, occurrences,
// balances, planned expenses, goals, the cushion or the primary income: a debounced singleton per
// household (2 s). Idempotent: the same input yields the same snapshot row.
//
// The API computes on read as well (a stale or missing snapshot never blocks a request), so this job warms
// the cache and keeps the stored snapshot current for readers such as Explain and the weekly digest.
import { z } from "zod";
import { recomputePlan, type RecomputeResult, type WorkerDb } from "@mp/db";

export const PLAN_RECOMPUTE_QUEUE = "plan.recompute";
/** Changes inside one slot of this length collapse into a single job (BACKEND_PLAN §7.2). */
export const PLAN_RECOMPUTE_DEBOUNCE_SECONDS = 2;

export const PlanRecomputeJob = z.object({ householdId: z.uuid() });
export type PlanRecomputeJob = z.infer<typeof PlanRecomputeJob>;

/** Queue settings: 3 attempts with exponential backoff (BACKEND_PLAN §9). */
export const PLAN_RECOMPUTE_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 5, retryBackoff: true } as const;

/** The part of pg-boss the enqueue helpers need (a fake in unit tests). */
export interface JobSender {
  send(
    name: string,
    data: object,
    options?: { singletonKey?: string; singletonSeconds?: number; startAfter?: number },
  ): Promise<string | null>;
}

/**
 * pg-boss send options for a debounced singleton: one job per household per 2-second slot, started after
 * the slot so a burst of writes is computed once, on the final data.
 */
export function planRecomputeSendOptions(job: PlanRecomputeJob) {
  return {
    singletonKey: `${PLAN_RECOMPUTE_QUEUE}:${job.householdId}`,
    singletonSeconds: PLAN_RECOMPUTE_DEBOUNCE_SECONDS,
    startAfter: PLAN_RECOMPUTE_DEBOUNCE_SECONDS,
  } as const;
}

/**
 * Enqueue a recompute after a data change. NOT WIRED YET: no write path calls this, because the API has no
 * queue connection until the `mp_queue` role exists (WP-09; the hooks are on the WP-26 checklist, Q-102).
 * `GET /plan` computes on read, so plans are correct without it.
 * Returns the job id, or null when one is already queued.
 */
export async function enqueuePlanRecompute(sender: JobSender, householdId: string): Promise<string | null> {
  const job = PlanRecomputeJob.parse({ householdId });
  return sender.send(PLAN_RECOMPUTE_QUEUE, job, planRecomputeSendOptions(job));
}

export interface PlanRecomputeDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

export async function handlePlanRecompute(deps: PlanRecomputeDeps, data: unknown): Promise<RecomputeResult> {
  const job = PlanRecomputeJob.parse(data);
  return deps.db.withJobTx(job.householdId, (tx) =>
    recomputePlan(tx, job.householdId, { nowIso: deps.now() }),
  );
}
