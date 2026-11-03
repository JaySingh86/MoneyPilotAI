import { describe, expect, it } from "vitest";
import type { WorkerDb } from "@mp/db";
import { handleProposalsExpire, proposalsExpireSingletonKey } from "./expire";

const HH = "00000000-0000-4000-8000-000000000101";

function fakeDb(calls: string[]): WorkerDb {
  return {
    withJobTx: async (householdId: string) => {
      calls.push(householdId);
      return 0;
    },
    close: async () => undefined,
  } as unknown as WorkerDb;
}

describe("proposals.expire job", () => {
  it("runs scoped to exactly the job's household", async () => {
    const calls: string[] = [];
    await handleProposalsExpire(
      { db: fakeDb(calls), now: () => "2026-11-10T00:00:00Z" },
      { householdId: HH },
    );
    expect(calls).toEqual([HH]);
  });

  it("rejects malformed job data before touching the database", async () => {
    const calls: string[] = [];
    await expect(
      handleProposalsExpire(
        { db: fakeDb(calls), now: () => "2026-11-10T00:00:00Z" },
        { householdId: "nope" },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("uses one singleton key per household", () => {
    expect(proposalsExpireSingletonKey({ householdId: HH })).toBe(`proposals.expire:${HH}`);
  });
});
