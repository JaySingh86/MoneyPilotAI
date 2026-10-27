import { Temporal, parseDate } from "../dates";
import { EngineError } from "../errors";
import {
  HOLIDAY_TABLE_FIRST_YEAR,
  HOLIDAY_TABLE_LAST_YEAR,
  US_FEDERAL_HOLIDAYS,
  isBusinessDay,
  isUsFederalHoliday,
} from "./holidays";
import { applyWeekendRule } from "./weekend";

const d = (s: string) => parseDate(s);

// Independent derivation of the 11 holidays (5 U.S.C. 6103) with the Federal Reserve Sunday→Monday rule.
function derive(year: number): string[] {
  const first = (m: number) => Temporal.PlainDate.from({ year, month: m, day: 1 });
  const nthWeekday = (m: number, weekday: number, n: number) => {
    const f = first(m);
    return f.add({ days: ((weekday - f.dayOfWeek + 7) % 7) + 7 * (n - 1) });
  };
  const lastMonday = (m: number) => {
    const l = first(m).add({ months: 1 }).subtract({ days: 1 });
    return l.subtract({ days: (l.dayOfWeek - 1 + 7) % 7 });
  };
  const fixed = (m: number, day: number) => {
    const x = Temporal.PlainDate.from({ year, month: m, day });
    return x.dayOfWeek === 7 ? x.add({ days: 1 }) : x;
  };
  return [
    fixed(1, 1),
    nthWeekday(1, 1, 3),
    nthWeekday(2, 1, 3),
    lastMonday(5),
    fixed(6, 19),
    fixed(7, 4),
    nthWeekday(9, 1, 1),
    nthWeekday(10, 1, 2),
    fixed(11, 11),
    nthWeekday(11, 4, 4),
    fixed(12, 25),
  ].map(String);
}

describe("US federal holiday table", () => {
  it("has 11 holidays for every covered year and matches the statutory rules", () => {
    for (let y = HOLIDAY_TABLE_FIRST_YEAR; y <= HOLIDAY_TABLE_LAST_YEAR; y++) {
      expect(US_FEDERAL_HOLIDAYS.filter((h) => h.startsWith(`${y}-`))).toEqual(derive(y));
    }
  });

  it("matches the published 2026 and 2027 Federal Reserve schedules", () => {
    expect(US_FEDERAL_HOLIDAYS.filter((h) => h.startsWith("2026-"))).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      "2026-07-04",
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
    // Independence Day 2027 is a Sunday → observed Monday Jul 5.
    expect(isUsFederalHoliday(d("2027-07-05"))).toBe(true);
    expect(isUsFederalHoliday(d("2027-07-04"))).toBe(false);
  });

  it("fails loudly outside the table range", () => {
    expect(() => isUsFederalHoliday(d("2036-01-01"))).toThrow(EngineError);
    expect(() => isUsFederalHoliday(d("2023-12-25"))).toThrow(EngineError);
  });

  it("knows business days", () => {
    expect(isBusinessDay(d("2026-11-26"))).toBe(false); // Thanksgiving
    expect(isBusinessDay(d("2026-10-31"))).toBe(false); // Saturday
    expect(isBusinessDay(d("2026-11-01"))).toBe(false); // Sunday
    expect(isBusinessDay(d("2026-11-02"))).toBe(true);
  });
});

describe("applyWeekendRule", () => {
  it("leaves the date alone with `none`", () => {
    expect(applyWeekendRule(d("2026-10-31"), "none").toString()).toBe("2026-10-31");
  });

  it("keeps business days", () => {
    expect(applyWeekendRule(d("2026-11-02"), "next_business_day").toString()).toBe("2026-11-02");
    expect(applyWeekendRule(d("2026-11-02"), "prev_business_day").toString()).toBe("2026-11-02");
  });

  it("shifts a Saturday to Friday or Monday", () => {
    expect(applyWeekendRule(d("2026-10-31"), "prev_business_day").toString()).toBe("2026-10-30");
    expect(applyWeekendRule(d("2026-10-31"), "next_business_day").toString()).toBe("2026-11-02");
  });

  it("skips a holiday next to a weekend", () => {
    // Sat Jan 16 2027 → Mon Jan 18 is MLK Day → Tue Jan 19.
    expect(applyWeekendRule(d("2027-01-16"), "next_business_day").toString()).toBe("2027-01-19");
    // Thanksgiving Thu Nov 26 2026 → Wed Nov 25 / Fri Nov 27.
    expect(applyWeekendRule(d("2026-11-26"), "prev_business_day").toString()).toBe("2026-11-25");
    expect(applyWeekendRule(d("2026-11-26"), "next_business_day").toString()).toBe("2026-11-27");
    // Sun Jul 4 2027, observed Mon Jul 5 → previous is Fri Jul 2, next is Tue Jul 6.
    expect(applyWeekendRule(d("2027-07-04"), "prev_business_day").toString()).toBe("2027-07-02");
    expect(applyWeekendRule(d("2027-07-04"), "next_business_day").toString()).toBe("2027-07-06");
  });

  it("crosses a year boundary", () => {
    // Fri Jan 1 2027 is a holiday → previous business day is Thu Dec 31 2026.
    expect(applyWeekendRule(d("2027-01-01"), "prev_business_day").toString()).toBe("2026-12-31");
  });
});
