import { parseDate } from "../dates";
import { EngineError } from "../errors";
import { expandSchedule, validateSchedule } from "./expand";
import type { Schedule } from "./types";

const expand = (s: Schedule, from: string, to: string) =>
  expandSchedule(s, parseDate(from), parseDate(to)).map(String);

describe("monthly on the 1st", () => {
  const s: Schedule = { type: "monthly_day", day: 1, dtstart: "2026-01-01" };

  it("lands on the 1st of each month across a year end", () => {
    expect(expand(s, "2026-10-27", "2027-02-15")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
    ]);
  });

  it("includes both range ends", () => {
    expect(expand(s, "2026-11-01", "2026-12-01")).toEqual(["2026-11-01", "2026-12-01"]);
  });

  it("never starts before dtstart or after until", () => {
    const bounded: Schedule = { ...s, dtstart: "2026-11-02", until: "2027-01-01" };
    expect(expand(bounded, "2026-10-01", "2027-06-01")).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it("returns nothing for an empty range", () => {
    expect(expand(s, "2026-11-02", "2026-11-01")).toEqual([]);
  });

  it("steps over a leap February", () => {
    expect(expand(s, "2028-01-31", "2028-03-31")).toEqual(["2028-02-01", "2028-03-01"]);
  });
});

describe("monthly on a day that some months lack (month-end clamp, Q-004)", () => {
  it("day 29 falls on Feb 28 in a common year and Feb 29 in a leap year", () => {
    const s: Schedule = { type: "monthly_day", day: 29, dtstart: "2026-01-01" };
    expect(expand(s, "2027-01-01", "2027-03-31")).toEqual(["2027-01-29", "2027-02-28", "2027-03-29"]);
    expect(expand(s, "2028-01-01", "2028-03-31")).toEqual(["2028-01-29", "2028-02-29", "2028-03-29"]);
  });

  it("day 31 falls on the 30th in 30-day months", () => {
    const s: Schedule = { type: "monthly_day", day: 31, dtstart: "2026-01-01" };
    expect(expand(s, "2027-01-01", "2027-06-30")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
    ]);
  });
});

describe("last day of the month", () => {
  const s: Schedule = { type: "monthly_last_day", dtstart: "2026-01-01" };

  it("handles 30, 31, 28 and leap 29", () => {
    expect(expand(s, "2026-10-27", "2027-03-01")).toEqual([
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
    expect(expand(s, "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });
});

describe("last Friday of the month", () => {
  const s: Schedule = { type: "monthly_last_weekday", weekday: "friday", dtstart: "2026-01-01" };

  it("matches the calendar", () => {
    expect(expand(s, "2026-10-01", "2027-02-28")).toEqual([
      "2026-10-30",
      "2026-11-27",
      "2026-12-25",
      "2027-01-29",
      "2027-02-26",
    ]);
  });

  it("works when the month ends on that weekday and in a leap February", () => {
    // Jul 31 2026 is a Friday; Feb 2028 ends on Tuesday the 29th → Feb 25.
    expect(expand(s, "2026-07-01", "2026-07-31")).toEqual(["2026-07-31"]);
    expect(expand(s, "2028-02-01", "2028-02-29")).toEqual(["2028-02-25"]);
  });
});

describe("every other Friday from an anchor", () => {
  const s: Schedule = { type: "every_n_weeks", n: 2, dtstart: "2026-11-06" };

  it("steps 14 days from the anchor", () => {
    expect(expand(s, "2026-10-27", "2027-01-15")).toEqual([
      "2026-11-06",
      "2026-11-20",
      "2026-12-04",
      "2026-12-18",
      "2027-01-01",
      "2027-01-15",
    ]);
  });

  it("starts mid-series", () => {
    expect(expand(s, "2026-12-05", "2026-12-31")).toEqual(["2026-12-18"]);
  });

  it("crosses leap day", () => {
    const leap: Schedule = { type: "every_n_weeks", n: 2, dtstart: "2028-02-18" };
    expect(expand(leap, "2028-02-01", "2028-03-20")).toEqual(["2028-02-18", "2028-03-03", "2028-03-17"]);
  });

  it("weekly is n = 1", () => {
    const weekly: Schedule = { type: "every_n_weeks", n: 1, dtstart: "2026-11-06" };
    expect(expand(weekly, "2026-11-06", "2026-11-27")).toEqual([
      "2026-11-06",
      "2026-11-13",
      "2026-11-20",
      "2026-11-27",
    ]);
  });
});

describe("every 6 months", () => {
  it("keeps the anchor day", () => {
    const s: Schedule = { type: "every_n_months", n: 6, dtstart: "2026-11-04" };
    expect(expand(s, "2026-01-01", "2028-01-01")).toEqual(["2026-11-04", "2027-05-04", "2027-11-04"]);
  });

  it("clamps an anchor on the 31st, including leap February", () => {
    const s: Schedule = { type: "every_n_months", n: 6, dtstart: "2027-08-31" };
    expect(expand(s, "2027-01-01", "2029-03-01")).toEqual([
      "2027-08-31",
      "2028-02-29",
      "2028-08-31",
      "2029-02-28",
    ]);
  });

  it("quarterly is n = 3", () => {
    const s: Schedule = { type: "every_n_months", n: 3, dtstart: "2026-11-18" };
    expect(expand(s, "2026-11-01", "2027-11-30")).toEqual([
      "2026-11-18",
      "2027-02-18",
      "2027-05-18",
      "2027-08-18",
      "2027-11-18",
    ]);
  });
});

describe("yearly", () => {
  it("repeats on the anchor month and day", () => {
    const s: Schedule = { type: "yearly", dtstart: "2027-01-09" };
    expect(expand(s, "2026-01-01", "2029-12-31")).toEqual(["2027-01-09", "2028-01-09", "2029-01-09"]);
  });

  it("a Feb 29 anchor falls on Feb 28 in common years", () => {
    const s: Schedule = { type: "yearly", dtstart: "2028-02-29" };
    expect(expand(s, "2028-01-01", "2032-12-31")).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("a Dec 31 anchor stays on the last day of the year", () => {
    const s: Schedule = { type: "yearly", dtstart: "2026-12-31" };
    expect(expand(s, "2026-12-31", "2028-12-31")).toEqual(["2026-12-31", "2027-12-31", "2028-12-31"]);
  });
});

describe("validateSchedule", () => {
  const bad: Schedule[] = [
    { type: "monthly_day", day: 0, dtstart: "2026-01-01" },
    { type: "monthly_day", day: 32, dtstart: "2026-01-01" },
    { type: "monthly_day", day: 1.5, dtstart: "2026-01-01" },
    { type: "every_n_weeks", n: 0, dtstart: "2026-01-01" },
    { type: "every_n_months", n: 0, dtstart: "2026-01-01" },
    // Monthly is its own type (monthly_day); every_n_months needs n ≥ 2.
    { type: "every_n_months", n: 1, dtstart: "2026-01-01" },
    { type: "monthly_day", day: 1, dtstart: "2026-02-30" },
    { type: "monthly_day", day: 1, dtstart: "2026-03-01", until: "2026-02-01" },
    { type: "monthly_last_weekday", weekday: "fri" as "friday", dtstart: "2026-01-01" },
  ];

  it.each(bad.map((s) => [JSON.stringify(s), s] as const))("rejects %s", (_label, s) => {
    expect(() => validateSchedule(s)).toThrow(EngineError);
  });
});
