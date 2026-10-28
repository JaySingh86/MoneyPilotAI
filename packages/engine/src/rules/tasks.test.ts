import { riveraFixture, RIVERA_TASKS } from "../testing";
import type { TaskInput } from "../types";
import { tasksDueThisWeek } from "./tasks";
import { ownerMatches } from "./owners";

const today = riveraFixture.today;

describe("tasksDueThisWeek (rule 15)", () => {
  it("groups the canvas tasks", () => {
    const t = tasksDueThisWeek(RIVERA_TASKS, today);
    expect(t.dueThisWeek.map((x) => x.id)).toEqual(["t1", "t2", "t3"]);
    expect(t.later.map((x) => x.id)).toEqual(["t4", "t5", "t6", "t7"]);
    expect(t.done.map((x) => x.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("is inclusive of day 7, includes overdue tasks, and puts undated ones in Later", () => {
    const tasks: TaskInput[] = [
      { id: "a", title: "Day 7", owner: "both", dueOn: "2026-11-03", completed: false },
      { id: "b", title: "Day 8", owner: "both", dueOn: "2026-11-04", completed: false },
      { id: "c", title: "Overdue", owner: "both", dueOn: "2026-10-20", completed: false },
      { id: "d", title: "Undated", owner: "both", dueOn: null, completed: false },
      { id: "e", title: "Undated 2", owner: "both", dueOn: null, completed: false },
      { id: "f", title: "Same day", owner: "both", dueOn: "2026-11-03", completed: false },
    ];
    const t = tasksDueThisWeek(tasks, today);
    expect(t.dueThisWeek.map((x) => x.id)).toEqual(["c", "a", "f"]);
    expect(t.later.map((x) => x.id)).toEqual(["b", "d", "e"]);
    expect(t.navBadge).toBe(3);
  });

  it("filters by owner (rule 13) but keeps the badge for the household", () => {
    const sam = tasksDueThisWeek(RIVERA_TASKS, today, { owner: "m-sam" });
    expect(sam.dueThisWeek.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(sam.navBadge).toBe(3);
    const jordan = tasksDueThisWeek(RIVERA_TASKS, today, { owner: "m-jordan" });
    expect(jordan.dueThisWeek.map((x) => x.id)).toEqual(["t1", "t3"]);
    expect(jordan.done).toEqual([]);
  });
});

describe("ownerMatches (rule 13)", () => {
  it("own items plus Both and Split", () => {
    expect(ownerMatches("m-sam", "m-sam")).toBe(true);
    expect(ownerMatches("both", "m-sam")).toBe(true);
    expect(ownerMatches("split", "m-sam")).toBe(true);
    expect(ownerMatches("m-jordan", "m-sam")).toBe(false);
    expect(ownerMatches("m-jordan", null)).toBe(true);
  });
});
