import { describe, expect, it, vi } from "vitest";
import type { WorkerDb } from "@mp/db";
import { MATERIALIZE_QUEUE } from "./materialize";
import { OCCURRENCES_SWEEP_CRON, handleOccurrencesSweep } from "./sweep";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";

describe("occurrences.sweep (nightly fan-out, Q-051)", () => {
  it("runs at 02:00 UTC", () => {
    expect(OCCURRENCES_SWEEP_CRON).toBe("0 2 * * *");
  });

  it("enqueues one materialize job per household with the item-change singleton key", async () => {
    const send = vi.fn(async () => "id");
    const db = { listHouseholdIds: async () => [A, B] } as unknown as WorkerDb;
    const result = await handleOccurrencesSweep({ db, sender: { send } });
    expect(result).toEqual({ households: 2, enqueued: 2 });
    expect(send).toHaveBeenCalledWith(
      MATERIALIZE_QUEUE,
      { householdId: A },
      { singletonKey: `occurrences.materialize:${A}` },
    );
    expect(send).toHaveBeenCalledWith(
      MATERIALIZE_QUEUE,
      { householdId: B },
      { singletonKey: `occurrences.materialize:${B}` },
    );
  });

  it("counts a household whose job is already queued as not enqueued, and handles an empty list", async () => {
    const send = vi.fn(async (_n: string, data: object) =>
      (data as { householdId: string }).householdId === A ? null : "id",
    );
    const db = { listHouseholdIds: async () => [A, B] } as unknown as WorkerDb;
    expect(await handleOccurrencesSweep({ db, sender: { send } })).toEqual({ households: 2, enqueued: 1 });
    const none = { listHouseholdIds: async () => [] } as unknown as WorkerDb;
    expect(await handleOccurrencesSweep({ db: none, sender: { send } })).toEqual({
      households: 0,
      enqueued: 0,
    });
  });
});
