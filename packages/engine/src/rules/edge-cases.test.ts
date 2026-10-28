// Edge cases across the rules: defaults for missing optional fields and deterministic tie-breaks.
import { riveraFixture, riveraInput } from "../testing";
import type { Flag, ItemInput, TaskInput } from "../types";
import { billsAverages } from "./bills-averages";
import { calendarMonth } from "./calendar";
import { ruleFlags, sortFlags } from "./flags";
import { shortfallOptions } from "./shortfall";
import { tasksDueThisWeek } from "./tasks";

describe("defaults", () => {
  it("an item with no status is active (bills averages)", () => {
    const input = riveraInput();
    for (const i of input.items) delete i.status;
    const b = billsAverages(input);
    expect(b.rows).toBe(18);
    expect(b.monthlyBillsAverageCents).toBe(495694);
  });

  it("an overdue row of an item with no weekend rule uses its scheduled date", () => {
    const input = riveraInput({ occurrences: [{ itemId: "b-car", scheduledOn: "2026-08-29" }] });
    delete (input.items.find((i) => i.id === "b-car") as ItemInput).weekendRule;
    expect(ruleFlags(input).filter((f) => f.code === "overdue")).toEqual([
      { code: "overdue", subjectId: "b-car", date: "2026-08-29" },
    ]);
  });

  it("a planned expense with no status is planned, a goal with no type saves (calendar)", () => {
    const input = riveraInput();
    for (const p of input.plannedExpenses) delete p.status;
    for (const g of input.goals) delete g.type;
    // Holiday gifts (no monthly amount) still sends no transfer.
    expect(calendarMonth(input, "2026-11").summary.goalsAndPlannedCents).toBe(80000);
  });
});

describe("tie-breaks", () => {
  it("flags with no subject keep their order", () => {
    const a: Flag = { code: "stale_balance", subjectId: null, date: "2026-01-01" };
    const b: Flag = { code: "stale_balance", subjectId: null, date: "2026-01-01" };
    expect(sortFlags([a, b])).toEqual([a, b]);
  });

  it("calendar chips: income first, then kind, then item id", () => {
    const input = riveraInput();
    const rent = input.items.find((i) => i.id === "b-rent") as ItemInput;
    input.items.push({ ...rent, id: "b-aaa", name: "Also rent" });
    const m = calendarMonth(input, "2026-11");
    const nov1 = m.days.find((d) => d.date === "2026-11-01")?.entries ?? [];
    expect(nov1.map((e) => e.sourceId)).toEqual(["b-aaa", "b-rent"]);
  });

  it("undated tasks go last whichever side of the comparison they are on", () => {
    const dated: TaskInput = { id: "z", title: "Z", owner: "both", dueOn: "2026-12-01", completed: false };
    const undated: TaskInput = { id: "a", title: "A", owner: "both", dueOn: null, completed: false };
    const today = riveraFixture.today;
    expect(tasksDueThisWeek([dated, undated], today).later.map((x) => x.id)).toEqual(["z", "a"]);
    expect(tasksDueThisWeek([undated, dated], today).later.map((x) => x.id)).toEqual(["z", "a"]);
  });

  it("shortfall option 3 takes the earliest of equal bills, then the lowest item id", () => {
    const input = riveraInput({ scenario: "shortfall" });
    for (const i of input.items) i.movable = false;
    const make = (id: string, day: number): ItemInput => ({
      id,
      name: id,
      direction: "outflow",
      kind: "subscription",
      owner: "m-sam",
      amount: { type: "fixed", cents: 5000 },
      schedule: { type: "monthly_day", day, dtstart: "2026-01-01" },
    });
    input.items.push(make("s-c", 2), make("s-b", 1), make("s-a", 1));
    const o = shortfallOptions(input).find((x) => x.kind === "move_bill_to_payday");
    expect(o).toMatchObject({ itemId: "s-a", fromDate: "2026-11-01" });
  });
});
