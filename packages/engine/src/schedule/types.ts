/** A household-local calendar date, `YYYY-MM-DD` (ADR-007). Parsed to Temporal.PlainDate inside the engine. */
export type IsoDate = string;

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

/** How a due date that lands on a weekend or US federal holiday is shifted (BACKEND_PLAN §5.2 `weekend_rule`). */
export type WeekendRule = "none" | "prev_business_day" | "next_business_day";

interface ScheduleBounds {
  /**
   * RRULE `DTSTART`. For anchored schedules (`every_n_weeks`, `every_n_months`, `yearly`) this is a real
   * occurrence and sets the cadence. For the monthly schedules it is only the lower bound;
   * `scheduleToRRule` snaps it to the first real occurrence, as RFC 5545 requires.
   */
  dtstart: IsoDate;
  /** RRULE `UNTIL` (inclusive). */
  until?: IsoDate | null;
}

/**
 * The friendly schedule union (BACKEND_PLAN §7.1). The UI never shows RRULE.
 *
 * Month-end clamping: a day that does not exist in a month (the 30th in February, or an anchor on the
 * 31st every 6 months) falls on that month's last day instead of being skipped. See QUESTIONS.md Q-004.
 */
export type Schedule =
  /** Monthly on a fixed day, 1–31. */
  | ({ type: "monthly_day"; day: number } & ScheduleBounds)
  /** Monthly on the last day of the month. */
  | ({ type: "monthly_last_day" } & ScheduleBounds)
  /** Monthly on the last given weekday, e.g. the last Friday. */
  | ({ type: "monthly_last_weekday"; weekday: Weekday } & ScheduleBounds)
  /** Every n weeks on the weekday of `dtstart` (biweekly payroll is n = 2). */
  | ({ type: "every_n_weeks"; n: number } & ScheduleBounds)
  /** Every n months (n ≥ 2) on the day of month of `dtstart`. Quarterly is n = 3. */
  | ({ type: "every_n_months"; n: number } & ScheduleBounds)
  /** Every year on the month and day of `dtstart`. */
  | ({ type: "yearly" } & ScheduleBounds);

export type ScheduleType = Schedule["type"];
