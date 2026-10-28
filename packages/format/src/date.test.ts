import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { date, relative, weekday } from "./date";

const pd = (s: string) => Temporal.PlainDate.from(s);
const today = pd("2026-10-27");

describe("date", () => {
  it.each([
    ["2026-01-01", "Jan 1"],
    ["2026-02-28", "Feb 28"],
    ["2026-03-15", "Mar 15"],
    ["2026-04-30", "Apr 30"],
    ["2026-05-05", "May 5"],
    ["2026-06-06", "Jun 6"],
    ["2026-07-04", "Jul 4"],
    ["2026-08-31", "Aug 31"],
    ["2026-09-28", "Sep 28"],
    ["2026-10-27", "Oct 27"],
    ["2026-11-04", "Nov 4"],
    ["2026-12-31", "Dec 31"],
  ])("current year %s → %s", (iso, expected) => {
    expect(date(pd(iso), { relativeTo: today })).toBe(expected);
  });

  it("adds the year outside the current year, past or future", () => {
    expect(date(pd("2027-01-09"), { relativeTo: today })).toBe("Jan 9, 2027");
    expect(date(pd("2025-12-31"), { relativeTo: today })).toBe("Dec 31, 2025");
  });

  it("uses the relativeTo date for the current year, not a clock", () => {
    expect(date(pd("2027-01-09"), { relativeTo: pd("2027-01-01") })).toBe("Jan 9");
  });

  it.each([
    ["2026-11-02", "Mon, Nov 2"],
    ["2026-10-27", "Tue, Oct 27"],
    ["2026-11-04", "Wed, Nov 4"],
    ["2026-11-05", "Thu, Nov 5"],
    ["2026-11-06", "Fri, Nov 6"],
    ["2026-10-31", "Sat, Oct 31"],
    ["2026-11-01", "Sun, Nov 1"],
    ["2027-01-09", "Sat, Jan 9, 2027"],
  ])("weekday %s → %s", (iso, expected) => {
    expect(date(pd(iso), { relativeTo: today, weekday: true })).toBe(expected);
  });

  it("handles a leap day", () => {
    expect(date(pd("2028-02-29"), { relativeTo: today, weekday: true })).toBe("Tue, Feb 29, 2028");
  });
});

describe("relative", () => {
  it("formats future days", () => {
    expect(relative(8)).toBe("in 8 days");
    expect(relative(2)).toBe("in 2 days");
    expect(relative(1)).toBe("tomorrow");
  });

  it("formats today and past days", () => {
    expect(relative(0)).toBe("today");
    expect(relative(-1)).toBe("yesterday");
    expect(relative(-3)).toBe("3 days ago");
  });

  it("matches a PlainDate difference (fixture today → Nov 4)", () => {
    expect(relative(today.until(pd("2026-11-04")).days)).toBe("in 8 days");
  });

  it("rejects non-integer days", () => {
    expect(() => relative(1.5)).toThrow(TypeError);
  });
});

describe("date with a long month and weekday()", () => {
  const nov4 = { year: 2026, month: 11, day: 4, dayOfWeek: 3 };
  it("spells the month out for screen-reader labels", () => {
    expect(date(nov4, { relativeTo: { year: 2026 }, month: "long" })).toBe("November 4");
    expect(date(nov4, { relativeTo: { year: 2025 }, month: "long" })).toBe("November 4, 2026");
    expect(date(nov4, { relativeTo: { year: 2026 }, month: "long", weekday: true })).toBe("Wed, November 4");
  });

  it("returns the short weekday alone", () => {
    expect(weekday(nov4)).toBe("Wed");
    expect(weekday({ year: 2026, month: 11, day: 1, dayOfWeek: 7 })).toBe("Sun");
    expect(() => weekday({ year: 2026, month: 11, day: 1, dayOfWeek: 9 })).toThrow(RangeError);
  });
});
