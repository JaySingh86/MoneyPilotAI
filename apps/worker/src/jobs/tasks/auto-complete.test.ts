import { describe, expect, it } from "vitest";
import type { WorkerDb } from "@mp/db";
import { handleTasksAutoComplete, tasksAutoCompleteSingletonKey } from "./auto-complete";

const HH = "00000000-0000-4000-8000-000000000101";
const ITEM = "00000000-0000-4000-8000-000000000202";
const PROPOSAL = "00000000-0000-4000-8000-000000000303";

function fakeDb(calls: string[]): WorkerDb {
  return {
    withJobTx: async (householdId: string) => {
      calls.push(householdId);
      return [];
    },
    close: async () => undefined,
  } as unknown as WorkerDb;
}

describe("tasks.auto_complete job", () => {
  it("runs scoped to exactly the job's household, for each event type", async () => {
    const calls: string[] = [];
    const deps = { db: fakeDb(calls) };
    await handleTasksAutoComplete(deps, {
      householdId: HH,
      event: { type: "actual_amount_received", itemId: ITEM },
    });
    await handleTasksAutoComplete(deps, { householdId: HH, event: { type: "item_reviewed", itemId: ITEM } });
    await handleTasksAutoComplete(deps, {
      householdId: HH,
      event: { type: "proposal_decided", proposalId: PROPOSAL },
    });
    expect(calls).toEqual([HH, HH, HH]);
  });

  it("rejects an unknown event or a malformed id before touching the database", async () => {
    const calls: string[] = [];
    const deps = { db: fakeDb(calls) };
    await expect(
      handleTasksAutoComplete(deps, { householdId: HH, event: { type: "paid", itemId: ITEM } }),
    ).rejects.toThrow();
    await expect(
      handleTasksAutoComplete(deps, { householdId: HH, event: { type: "item_reviewed", itemId: "nope" } }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("keys the singleton on the event and its subject", () => {
    expect(
      tasksAutoCompleteSingletonKey({
        householdId: HH,
        event: { type: "actual_amount_received", itemId: ITEM },
      }),
    ).toBe(`tasks.auto_complete:actual_amount_received:${ITEM}`);
    expect(
      tasksAutoCompleteSingletonKey({
        householdId: HH,
        event: { type: "proposal_decided", proposalId: PROPOSAL },
      }),
    ).toBe(`tasks.auto_complete:proposal_decided:${PROPOSAL}`);
  });
});
