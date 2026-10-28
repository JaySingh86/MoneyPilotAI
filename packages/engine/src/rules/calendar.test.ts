import { EngineError } from "../errors";
import { riveraInput } from "../testing";
import type { CalendarEntry } from "./calendar";
import { calendarMonth } from "./calendar";

function day(month: ReturnType<typeof calendarMonth>, date: string): CalendarEntry[] {
  return month.days.find((d) => d.date === date)?.entries ?? [];
}

describe("calendarMonth (DESIGN_SPEC §4.2, §5.1 Calendar)", () => {
  const nov = calendarMonth(riveraInput(), "2026-11");

  it("has every day of the month, with paydays marked", () => {
    expect(nov.month).toBe("2026-11");
    expect(nov.days).toHaveLength(30);
    expect(nov.days.filter((d) => d.isPayday).map((d) => d.date)).toEqual(["2026-11-06", "2026-11-20"]);
  });

  it("gives each chip its canvas kind", () => {
    const kinds = (date: string) => day(nov, date).map((e) => [e.name, e.kind, e.amountCents]);
    expect(kinds("2026-11-02")).toEqual([
      ["Daycare", "bill", -124000],
      ["Streaming bundle", "decision", -2299],
    ]);
    expect(kinds("2026-11-03")).toEqual([["Electricity", "estimate", -14200]]);
    expect(kinds("2026-11-04")).toEqual([["Car insurance renewal", "decision", -68400]]);
    expect(kinds("2026-11-06")).toEqual([
      ["Sam’s pay", "income", 315000],
      ["goal_transfer", "goal_transfer", -55000],
    ]);
    expect(kinds("2026-11-15")).toEqual([["Credit card", "estimate", -64000]]);
    expect(kinds("2026-11-21")).toEqual([["Music (second service)", "decision", -1099]]);
    expect(kinds("2026-11-26")).toEqual([["Thanksgiving", "planned", -25000]]);
    expect(day(nov, "2026-11-06")[1]?.goalIds).toEqual(["g-emergency", "g-tahoe"]);
    expect(day(nov, "2026-11-04")[0]?.flagCodes).toEqual(["not_usual_month"]);
    expect(day(nov, "2026-11-02")[1]?.flagCodes).toEqual(["price_up"]);
  });

  it("counts estimates", () => {
    expect(nov.summary.estimatesCount).toBe(2);
  });

  it("filters by owner (rule 13), totals included", () => {
    const sam = calendarMonth(riveraInput(), "2026-11", { owner: "m-sam" });
    expect(day(sam, "2026-11-01")).toEqual([]); // Jordan's rent
    expect(day(sam, "2026-11-26")).toHaveLength(1); // Both
    expect(sam.summary.incomeCents).toBe(630000);
  });

  it("leaves out skipped occurrences, cancelled planned expenses and payroll items; keeps paid ones", () => {
    const input = riveraInput({
      occurrences: [
        { itemId: "b-rent", scheduledOn: "2026-11-01", status: "skipped" },
        { itemId: "b-daycare", scheduledOn: "2026-11-02", status: "paid", paidOn: "2026-10-30" },
      ],
    });
    input.plannedExpenses[0] = { ...input.plannedExpenses[0]!, status: "cancelled" };
    input.items.find((i) => i.id === "b-car")!.paidFrom = "payroll";
    const m = calendarMonth(input, "2026-11");
    expect(day(m, "2026-11-01")).toEqual([]);
    expect(day(m, "2026-11-02")[0]).toMatchObject({ name: "Daycare", status: "paid" });
    expect(day(m, "2026-11-26")).toEqual([]);
    expect(day(m, "2026-11-29")).toEqual([]);
  });

  it("has no goal transfers before today or when no goal saves monthly", () => {
    expect(
      calendarMonth(riveraInput(), "2026-10")
        .days.flatMap((d) => d.entries)
        .map((e) => e.kind),
    ).not.toContain("goal_transfer");
    const input = riveraInput();
    input.goals = input.goals.map((g) => ({ ...g, monthlyCents: null }));
    const m = calendarMonth(input, "2026-11");
    expect(m.summary.goalsAndPlannedCents).toBe(25000);
    const dec = calendarMonth(riveraInput(), "2026-12");
    expect(day(dec, "2026-12-04").map((e) => e.kind)).toContain("goal_transfer");
  });

  it("marks an overdue row as a decision", () => {
    const input = { ...riveraInput(), asOf: "2026-11-10", startingBalance: { cents: 0, asOf: "2026-11-10" } };
    input.occurrences = [{ itemId: "b-internet", scheduledOn: "2026-11-05" }];
    expect(day(calendarMonth(input, "2026-11"), "2026-11-05")[0]).toMatchObject({
      kind: "decision",
      flagCodes: ["overdue"],
    });
  });

  it("totals are 0 for an empty month view", () => {
    const m = calendarMonth(riveraInput(), "2026-11", { owner: "m-nobody" });
    expect(m.summary.billsCents).toBe(0);
    expect(Object.is(m.summary.billsCents, 0)).toBe(true);
  });

  it.each(["2026-13", "2026-1", "nope"])("rejects the month %s", (month) => {
    expect(() => calendarMonth(riveraInput(), month)).toThrow(EngineError);
  });
});
