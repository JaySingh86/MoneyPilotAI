import { describe, expect, it, vi } from "vitest";
import type { WorkerDb } from "@mp/db";
import {
  PLAN_RECOMPUTE_QUEUE,
  enqueuePlanRecompute,
  handlePlanRecompute,
  planRecomputeSendOptions,
  type JobSender,
} from "./recompute";

const HH = "00000000-0000-4000-8000-000000000101";

describe("plan.recompute job", () => {
  it("is a debounced singleton per household: one key, a 2 second slot", () => {
    expect(planRecomputeSendOptions({ householdId: HH })).toEqual({
      singletonKey: `plan.recompute:${HH}`,
      singletonSeconds: 2,
      startAfter: 2,
    });
  });

  it("enqueues on the plan.recompute queue with those options", async () => {
    const send = vi.fn(async () => "job-1");
    const sender: JobSender = { send };
    expect(await enqueuePlanRecompute(sender, HH)).toBe("job-1");
    expect(send).toHaveBeenCalledWith(
      PLAN_RECOMPUTE_QUEUE,
      { householdId: HH },
      { singletonKey: `plan.recompute:${HH}`, singletonSeconds: 2, startAfter: 2 },
    );
  });

  it("refuses a malformed household id before sending", async () => {
    const send = vi.fn(async () => "x");
    await expect(enqueuePlanRecompute({ send }, "not-a-uuid")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("runs scoped to exactly the job's household and rejects malformed data before the database", async () => {
    const scopes: string[] = [];
    const db = {
      withJobTx: async (householdId: string) => {
        scopes.push(householdId);
        return { status: "no_household" };
      },
    } as unknown as WorkerDb;
    const deps = { db, now: () => "2026-10-27T16:00:00Z" };
    await handlePlanRecompute(deps, { householdId: HH });
    expect(scopes).toEqual([HH]);
    await expect(handlePlanRecompute(deps, { householdId: 5 })).rejects.toThrow();
    await expect(handlePlanRecompute(deps, null)).rejects.toThrow();
    expect(scopes).toEqual([HH]);
  });
});
