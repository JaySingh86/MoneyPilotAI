// The weekend rule: shifts a scheduled date off weekends and US federal holidays (BACKEND_PLAN §7.1).
import type { PlainDate } from "../dates";
import { isBusinessDay } from "./holidays";
import type { WeekendRule } from "./types";

export function applyWeekendRule(date: PlainDate, rule: WeekendRule): PlainDate {
  if (rule === "none") return date;
  const step = rule === "next_business_day" ? 1 : -1;
  let d = date;
  while (!isBusinessDay(d)) d = d.add({ days: step });
  return d;
}
