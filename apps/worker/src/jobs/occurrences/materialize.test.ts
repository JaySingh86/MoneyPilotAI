import { describe, expect, it } from "vitest";
import type { WorkerDb } from "@mp/db";
import { handleMaterialize, materializeSingletonKey } from "./materialize";

const HH = "00000000-0000-4000-8000-000000000101";
const ITEM = "00000000-0000-4000-8000-000000000202";

function fakeDb(calls: string[]): WorkerDb {
  return {
    withJobTx: async (householdId: string) => {
      calls.push(householdId);
      return { inserted: 0, deleted: 0 };
    },
    close: async () => undefined,
  } as unknown as WorkerDb;
}

describe("occurrences.materialize job", () => {
  it("runs scoped to exactly the job's household", async () => {
    const calls: string[] = [];
    await handleMaterialize({ db: fakeDb(calls), now: () => "2026-10-27T16:00:00Z" }, { householdId: HH });
    expect(calls).toEqual([HH]);
  });

  it("rejects malformed job data before touching the database", async () => {
    const calls: string[] = [];
    const deps = { db: fakeDb(calls), now: () => "2026-10-27T16:00:00Z" };
    await expect(handleMaterialize(deps, { householdId: "nope" })).rejects.toThrow();
    await expect(handleMaterialize(deps, { householdId: HH, itemId: 5 })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("uses one singleton key per item, or per household for the nightly sweep", () => {
    expect(materializeSingletonKey({ householdId: HH, itemId: ITEM })).toBe(
      `occurrences.materialize:${ITEM}`,
    );
    expect(materializeSingletonKey({ householdId: HH })).toBe(`occurrences.materialize:${HH}`);
  });
});
