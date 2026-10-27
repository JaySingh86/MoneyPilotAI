import { datetime, rrulestr } from "rrule";
import { WEEKDAYS, parseDate } from "../dates";
import type { PlainDate } from "../dates";
import { EngineError } from "../errors";
import { forAllSeeds } from "../testing/prng";
import type { Rng } from "../testing/prng";
import { expandSchedule } from "./expand";
import { scheduleFromRRule, scheduleToRRule } from "./rrule";
import type { Schedule } from "./types";

/**
 * Independent RFC 5545 check that a date is an instance of one of our RRULE shapes. It reads the RRULE
 * text only (not the Schedule, not expandSchedule, not the rrule library, which also tolerates an
 * unsynchronized DTSTART), so it can confirm that DTSTART is a real occurrence.
 */
function isInstance(rrule: string, date: PlainDate): boolean {
  const parts = new Map(rrule.split(";").map((p) => p.split("=") as [string, string]));
  const codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const monthDayOk = (spec: string | undefined) => {
    if (spec === undefined) return true;
    if (spec === "-1") return date.day === date.daysInMonth;
    const clamp = /^(\d+),-1$/.exec(spec);
    if (clamp)
      return parts.get("BYSETPOS") === "1" && date.day === Math.min(Number(clamp[1]), date.daysInMonth);
    return date.day === Number(spec);
  };
  switch (parts.get("FREQ")) {
    case "MONTHLY": {
      const byDay = parts.get("BYDAY");
      if (byDay) {
        return byDay === `-1${codes[date.dayOfWeek - 1]}` && date.day + 7 > date.daysInMonth;
      }
      return parts.has("BYMONTHDAY") && monthDayOk(parts.get("BYMONTHDAY"));
    }
    case "WEEKLY":
      return parts.get("BYDAY") === codes[date.dayOfWeek - 1];
    case "YEARLY":
      return Number(parts.get("BYMONTH")) === date.month && monthDayOk(parts.get("BYMONTHDAY"));
    default:
      return false;
  }
}

describe("scheduleToRRule (BACKEND_PLAN §7.1 mappings)", () => {
  // [name, schedule, RRULE, DTSTART snapped to the first real occurrence]
  const cases: [string, Schedule, string, string][] = [
    [
      "monthly on the 1st",
      { type: "monthly_day", day: 1, dtstart: "2026-01-01" },
      "FREQ=MONTHLY;BYMONTHDAY=1",
      "2026-01-01",
    ],
    [
      "last day of month",
      { type: "monthly_last_day", dtstart: "2026-01-01" },
      "FREQ=MONTHLY;BYMONTHDAY=-1",
      "2026-01-31",
    ],
    [
      "last Friday",
      { type: "monthly_last_weekday", weekday: "friday", dtstart: "2026-01-01" },
      "FREQ=MONTHLY;BYDAY=-1FR",
      "2026-01-30",
    ],
    [
      "every other Friday",
      { type: "every_n_weeks", n: 2, dtstart: "2026-11-06" },
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
      "2026-11-06",
    ],
    ["weekly", { type: "every_n_weeks", n: 1, dtstart: "2026-11-06" }, "FREQ=WEEKLY;BYDAY=FR", "2026-11-06"],
    [
      "every 6 months",
      { type: "every_n_months", n: 6, dtstart: "2026-11-04" },
      "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=4",
      "2026-11-04",
    ],
    [
      "quarterly",
      { type: "every_n_months", n: 3, dtstart: "2026-11-18" },
      "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=18",
      "2026-11-18",
    ],
    ["yearly", { type: "yearly", dtstart: "2027-01-09" }, "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=9", "2027-01-09"],
    [
      "monthly on the 29th (clamped)",
      { type: "monthly_day", day: 29, dtstart: "2026-01-01" },
      "FREQ=MONTHLY;BYMONTHDAY=29,-1;BYSETPOS=1",
      "2026-01-29",
    ],
    [
      "monthly on the 30th from mid-February (clamped)",
      { type: "monthly_day", day: 30, dtstart: "2027-02-10" },
      "FREQ=MONTHLY;BYMONTHDAY=30,-1;BYSETPOS=1",
      "2027-02-28",
    ],
    [
      "monthly on the 5th from the 6th",
      { type: "monthly_day", day: 5, dtstart: "2026-01-06" },
      "FREQ=MONTHLY;BYMONTHDAY=5",
      "2026-02-05",
    ],
    [
      "every 6 months from the 31st (clamped)",
      { type: "every_n_months", n: 6, dtstart: "2027-08-31" },
      "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=31,-1;BYSETPOS=1",
      "2027-08-31",
    ],
    [
      "yearly from Feb 29 (clamped)",
      { type: "yearly", dtstart: "2028-02-29" },
      "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29,-1;BYSETPOS=1",
      "2028-02-29",
    ],
  ];

  it.each(cases)("%s", (_name, schedule, rrule, dtstart) => {
    expect(scheduleToRRule(schedule)).toEqual({ rrule, dtstart, until: null });
  });

  it.each(cases)("DTSTART is a real occurrence: %s", (_name, schedule) => {
    const parts = scheduleToRRule(schedule);
    expect(isInstance(parts.rrule, parseDate(parts.dtstart))).toBe(true);
  });

  it.each(cases)("round-trips %s to the same dates", (_name, schedule, _rrule, dtstart) => {
    const back = scheduleFromRRule(scheduleToRRule(schedule));
    expect(back).toEqual({ ...schedule, dtstart });
    const range = [parseDate("2025-01-01"), parseDate("2030-12-31")] as const;
    expect(expandSchedule(back, ...range)).toEqual(expandSchedule(schedule, ...range));
  });

  it("carries until separately", () => {
    const s: Schedule = { type: "monthly_day", day: 5, dtstart: "2026-01-01", until: "2027-06-30" };
    const parts = scheduleToRRule(s);
    expect(parts).toEqual({ rrule: "FREQ=MONTHLY;BYMONTHDAY=5", dtstart: "2026-01-05", until: "2027-06-30" });
    expect(scheduleFromRRule(parts)).toEqual({ ...s, dtstart: "2026-01-05" });
  });

  it("rejects a schedule with no occurrence before until", () => {
    const s: Schedule = { type: "monthly_day", day: 20, dtstart: "2026-01-21", until: "2026-02-19" };
    expect(() => scheduleToRRule(s)).toThrow(EngineError);
  });
});

describe("scheduleFromRRule", () => {
  it("accepts the plain forms from BACKEND_PLAN §7.1", () => {
    expect(scheduleFromRRule({ rrule: "FREQ=YEARLY", dtstart: "2027-01-09" })).toEqual({
      type: "yearly",
      dtstart: "2027-01-09",
    });
    expect(scheduleFromRRule({ rrule: "RRULE:FREQ=MONTHLY;INTERVAL=3", dtstart: "2026-11-18" })).toEqual({
      type: "every_n_months",
      n: 3,
      dtstart: "2026-11-18",
    });
    expect(
      scheduleFromRRule({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20271231", dtstart: "2026-01-01" }),
    ).toEqual({
      type: "monthly_day",
      day: 1,
      dtstart: "2026-01-01",
      until: "2027-12-31",
    });
  });

  it("maps INTERVAL=1 monthly rules to the monthly types (every_n_months needs n ≥ 2)", () => {
    expect(
      scheduleFromRRule({ rrule: "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=4", dtstart: "2026-11-04" }),
    ).toEqual({
      type: "monthly_day",
      day: 4,
      dtstart: "2026-11-04",
    });
    expect(
      scheduleFromRRule({ rrule: "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1", dtstart: "2026-11-30" }),
    ).toEqual({
      type: "monthly_last_day",
      dtstart: "2026-11-30",
    });
    expect(scheduleFromRRule({ rrule: "FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR", dtstart: "2026-10-30" })).toEqual(
      {
        type: "monthly_last_weekday",
        weekday: "friday",
        dtstart: "2026-10-30",
      },
    );
  });

  const rejected: [string, string, string][] = [
    ["COUNT", "FREQ=MONTHLY;BYMONTHDAY=1;COUNT=3", "2026-01-01"],
    ["DAILY", "FREQ=DAILY", "2026-01-01"],
    ["a bare day 31 (would skip short months)", "FREQ=MONTHLY;BYMONTHDAY=31", "2026-01-31"],
    ["a bare yearly Feb 29", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "2028-02-29"],
    ["a weekday that is not DTSTART's", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-11-06"],
    ["an interval day that is not DTSTART's", "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=5", "2026-11-04"],
    ["every 2 months on the last day", "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1", "2026-11-30"],
    ["every 2 months on the last Friday", "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR", "2026-10-30"],
    ["the second-to-last Friday", "FREQ=MONTHLY;BYDAY=-2FR", "2026-01-01"],
    ["garbage", "FREQ", "2026-01-01"],
    ["an UNTIL with a time", "FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20271231T000000Z", "2026-01-01"],
  ];

  it.each(rejected)("rejects %s", (_name, rrule, dtstart) => {
    expect(() => scheduleFromRRule({ rrule, dtstart })).toThrow(EngineError);
  });
});

function randomSchedule(rng: Rng): { schedule: Schedule; start: PlainDate } {
  const y = rng.int(2024, 2027);
  const m = rng.int(1, 12);
  const start = parseDate(`${y}-${String(m).padStart(2, "0")}-01`).with({ day: rng.int(1, 31) });
  const dtstart = start.toString();
  const kind = rng.int(0, 5);
  const schedule: Schedule =
    kind === 0
      ? { type: "monthly_day", day: rng.int(1, 31), dtstart }
      : kind === 1
        ? { type: "monthly_last_day", dtstart }
        : kind === 2
          ? { type: "monthly_last_weekday", weekday: rng.pick(WEEKDAYS), dtstart }
          : kind === 3
            ? { type: "every_n_weeks", n: rng.int(1, 4), dtstart }
            : kind === 4
              ? { type: "every_n_months", n: rng.int(2, 12), dtstart }
              : { type: "yearly", dtstart };
  // Long enough to always contain an occurrence (the widest gap is 12 months).
  if (rng.bool(0.3)) schedule.until = start.add({ days: rng.int(400, 900) }).toString();
  return { schedule, start };
}

/** Expands the RRULE with the `rrule` library (an independent RFC 5545 implementation). */
function oracle(schedule: Schedule, from: string, to: string): string[] {
  const { rrule, dtstart, until } = scheduleToRRule(schedule);
  const compact = (iso: string) => iso.replaceAll("-", "");
  const text = `DTSTART:${compact(dtstart)}T000000Z\nRRULE:${rrule}${until ? `;UNTIL=${compact(until)}T000000Z` : ""}`;
  const f = parseDate(from);
  const t = parseDate(to);
  return rrulestr(text)
    .between(datetime(f.year, f.month, f.day), datetime(t.year, t.month, t.day), true)
    .map((d) => d.toISOString().slice(0, 10));
}

describe("random schedules", () => {
  it("DTSTART is always the first occurrence (strict RFC 5545 check)", () => {
    forAllSeeds(300, (rng) => {
      const { schedule, start } = randomSchedule(rng);
      const parts = scheduleToRRule(schedule);
      const first = expandSchedule(schedule, start, start.add({ years: 2 }))[0];
      expect(isInstance(parts.rrule, parseDate(parts.dtstart)), JSON.stringify(parts)).toBe(true);
      expect(parts.dtstart).toBe(first?.toString());
    });
  });

  it("expansion agrees with an independent RRULE implementation over 2024–2030", () => {
    forAllSeeds(300, (rng) => {
      const { schedule, start } = randomSchedule(rng);
      const from = start.subtract({ days: rng.int(0, 400) }).toString();
      const to = parseDate(from)
        .add({ days: rng.int(0, 1500) })
        .toString();
      const ours = expandSchedule(schedule, parseDate(from), parseDate(to)).map(String);
      expect(ours, JSON.stringify({ schedule, from, to })).toEqual(oracle(schedule, from, to));
    });
  });
});
