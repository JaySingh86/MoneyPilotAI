import { describe, expect, it } from "vitest";
import { CalendarQuery, PlanChange, WhatIfRequest } from "./index";

const UUID = "00000000-0000-4000-8000-000000000001";

describe("Calendar query", () => {
  it("validates month and owner", () => {
    expect(CalendarQuery.safeParse({ month: "2026-11" }).success).toBe(true);
    expect(CalendarQuery.safeParse({ month: "2026-00" }).success).toBe(false);
    expect(CalendarQuery.safeParse({ month: "2026-11", owner: "both" }).success).toBe(true);
    expect(CalendarQuery.safeParse({ month: "2026-11", owner: "someone" }).success).toBe(false);
  });
});

describe("What-if request", () => {
  it("accepts the §8.3 example and bounds the number of changes", () => {
    const move = { type: "move_occurrence", occurrenceId: UUID, toDate: "2026-11-06" };
    expect(WhatIfRequest.safeParse({ changes: [move] }).success).toBe(true);
    expect(WhatIfRequest.safeParse({ changes: [] }).success).toBe(false);
    expect(WhatIfRequest.safeParse({ changes: Array.from({ length: 11 }, () => move) }).success).toBe(false);
    expect(WhatIfRequest.safeParse({ changes: [move], extra: 1 }).success).toBe(false);
  });

  it("rejects floats, negatives and unknown change types", () => {
    expect(PlanChange.safeParse({ type: "add_transfer", amountCents: 10.5, on: "2026-11-01" }).success).toBe(
      false,
    );
    expect(
      PlanChange.safeParse({ type: "set_actual_amount", occurrenceId: UUID, amountCents: -1 }).success,
    ).toBe(false);
    expect(PlanChange.safeParse({ type: "pay_bill", itemId: UUID }).success).toBe(false);
  });
});
