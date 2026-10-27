// Expands a Schedule into its scheduled dates (`scheduled_on`) between two dates, inclusive.
// Semantics match the RRULE produced by `scheduleToRRule` (RFC 5545), including month-end clamping.
import { WEEKDAYS, compareDates, daysBetween, maxDate, minDate, parseDate, weekdayNumber } from "../dates";
import type { PlainDate } from "../dates";
import { EngineError } from "../errors";
import type { Schedule } from "./types";

const MAX_INTERVAL = 520;

function invalid(detail: string): never {
  throw new EngineError("invalid_schedule", detail);
}

function isIntIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Throws `invalid_schedule` unless the schedule is well formed. */
export function validateSchedule(schedule: Schedule): void {
  let start: PlainDate;
  try {
    start = parseDate(schedule.dtstart, "dtstart");
  } catch {
    invalid("dtstart must be a valid YYYY-MM-DD date");
  }
  if (schedule.until != null) {
    let until: PlainDate;
    try {
      until = parseDate(schedule.until, "until");
    } catch {
      invalid("until must be a valid YYYY-MM-DD date");
    }
    if (compareDates(until, start) < 0) invalid("until is before dtstart");
  }
  switch (schedule.type) {
    case "monthly_day":
      if (!isIntIn(schedule.day, 1, 31)) invalid("day must be an integer from 1 to 31");
      return;
    case "monthly_last_day":
    case "yearly":
      return;
    case "monthly_last_weekday":
      if (!WEEKDAYS.includes(schedule.weekday)) invalid("unknown weekday");
      return;
    case "every_n_weeks":
      if (!isIntIn(schedule.n, 1, MAX_INTERVAL)) invalid(`n must be an integer from 1 to ${MAX_INTERVAL}`);
      return;
    case "every_n_months":
      // Monthly is `monthly_day`; every_n_months starts at 2 so each RRULE maps to exactly one type.
      if (!isIntIn(schedule.n, 2, MAX_INTERVAL)) invalid(`n must be an integer from 2 to ${MAX_INTERVAL}`);
      return;
    default: {
      const never: never = schedule;
      invalid(`unknown schedule type ${String((never as { type: unknown }).type)}`);
    }
  }
}

function firstOfMonth(d: PlainDate): PlainDate {
  return d.with({ day: 1 });
}

/** The month-end-clamped date for `day` in the month of `monthStart`. */
function dayInMonth(monthStart: PlainDate, day: number): PlainDate {
  return monthStart.with({ day: Math.min(day, monthStart.daysInMonth) });
}

function lastWeekdayOfMonth(monthStart: PlainDate, isoWeekday: number): PlainDate {
  const last = monthStart.with({ day: monthStart.daysInMonth });
  return last.subtract({ days: (last.dayOfWeek - isoWeekday + 7) % 7 });
}

/** Months from `a` to `b` by calendar month, ignoring the day. */
function monthIndexDiff(a: PlainDate, b: PlainDate): number {
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Scheduled dates of `schedule` within [from, to], ascending. */
export function expandSchedule(schedule: Schedule, from: PlainDate, to: PlainDate): PlainDate[] {
  validateSchedule(schedule);
  const dtstart = parseDate(schedule.dtstart, "dtstart");
  const lo = maxDate(from, dtstart);
  const hi = schedule.until != null ? minDate(to, parseDate(schedule.until, "until")) : to;
  if (compareDates(lo, hi) > 0) return [];

  const out: PlainDate[] = [];
  const push = (d: PlainDate) => {
    if (compareDates(d, lo) >= 0 && compareDates(d, hi) <= 0) out.push(d);
  };

  switch (schedule.type) {
    case "monthly_day":
    case "monthly_last_day":
    case "monthly_last_weekday": {
      for (let m = firstOfMonth(lo); compareDates(m, hi) <= 0; m = m.add({ months: 1 })) {
        if (schedule.type === "monthly_day") push(dayInMonth(m, schedule.day));
        else if (schedule.type === "monthly_last_day") push(m.with({ day: m.daysInMonth }));
        else push(lastWeekdayOfMonth(m, weekdayNumber(schedule.weekday)));
      }
      break;
    }
    case "every_n_weeks": {
      const step = 7 * schedule.n;
      const k0 = Math.max(0, Math.ceil(daysBetween(dtstart, lo) / step));
      for (let d = dtstart.add({ days: k0 * step }); compareDates(d, hi) <= 0; d = d.add({ days: step }))
        push(d);
      break;
    }
    case "every_n_months":
    case "yearly": {
      // Always offset from dtstart (never chain), so a 31st anchor returns to the 31st after a short month.
      const stepMonths = schedule.type === "yearly" ? 12 : schedule.n;
      const k0 = Math.max(0, Math.floor(monthIndexDiff(dtstart, lo) / stepMonths));
      for (let k = k0; ; k++) {
        const d = dtstart.add({ months: k * stepMonths }, { overflow: "constrain" });
        if (compareDates(d, hi) > 0) break;
        push(d);
      }
      break;
    }
  }
  return out;
}
