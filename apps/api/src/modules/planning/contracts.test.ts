import { describe, expect, it } from "vitest";
import { billsAverages, calendarMonth, computeFullPlan, renewalsSummary } from "@mp/engine";
import { riveraInput } from "@mp/engine/testing";
import { BillsAverages, CalendarMonth, Plan, RenewalsSummary } from "@mp/contracts";

// The schemas mirror the engine's result types. Parsing the engine's output through them must keep every
// field, otherwise the API would silently drop data on its way out (Fastify serializes through Zod).
const UUID = "00000000-0000-4000-8000-000000000001";

function keysOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keysOf);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, keysOf(v)]),
    );
  }
  return value;
}

describe("planning contracts mirror the engine", () => {
  for (const scenario of ["base", "shortfall"] as const) {
    it(`Plan keeps everything the engine returns (${scenario})`, () => {
      const result = computeFullPlan(riveraInput({ scenario }));
      const wire = {
        calcSnapshotId: UUID,
        cushionCents: 50000,
        ...result,
        decisions: result.decisions.map((d) => ({ ...d, aiText: null })),
      };
      expect(keysOf(Plan.parse(wire))).toEqual(
        keysOf({ ...wire, runwayDetail: Plan.parse(wire).runwayDetail }),
      );
    });
  }

  it("Calendar, renewals summary and bills averages keep everything the engine returns", () => {
    const input = riveraInput();
    const cal = calendarMonth(input, "2026-11");
    expect(keysOf(CalendarMonth.parse(cal))).toEqual(keysOf(cal));
    const { rows: _rows, ...summary } = renewalsSummary(input);
    expect(keysOf(RenewalsSummary.parse(summary))).toEqual(keysOf(summary));
    const averages = billsAverages(input);
    const withUuids = {
      ...averages,
      byItem: averages.byItem.map((b, i) => ({
        ...b,
        itemId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      })),
    };
    expect(keysOf(BillsAverages.parse(withUuids))).toEqual(keysOf(withUuids));
  });
});
