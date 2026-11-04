// Text for items, renewals and sources, as the canvas words them.
import type { components } from "@mp/contracts/client";
import { ordinal, weekdayLong } from "./dates";

export type Item = components["schemas"]["Item"];
type Schedule = Item["schedule"];

const CATEGORY: Readonly<Record<Item["category"], string>> = {
  housing: "Housing",
  utilities: "Utilities",
  childcare: "Childcare",
  transport: "Transport",
  debt: "Debt",
  subscription: "Subscription",
  insurance: "Insurance",
  membership: "Membership",
  vehicle_home: "Vehicle & home",
  income: "Income",
  other: "Other",
};

export const categoryLabel = (c: Item["category"]): string => CATEGORY[c];

export function scheduleLabel(schedule: Schedule, amountType: Item["amountType"] = "fixed"): string {
  let text: string;
  switch (schedule.type) {
    case "monthly_day":
      text = `Monthly · ${ordinal(schedule.day)}`;
      break;
    case "monthly_last_day":
      text = "Monthly · last day";
      break;
    case "monthly_last_weekday":
      text = `Monthly · last ${schedule.weekday.charAt(0).toUpperCase()}${schedule.weekday.slice(1)}`;
      break;
    case "every_n_weeks":
      text =
        schedule.n === 1
          ? "Weekly"
          : schedule.n === 2
            ? `Every other ${weekdayLong(schedule.dtstart)}`
            : `Every ${schedule.n} weeks`;
      break;
    case "every_n_months":
      text = `Every ${schedule.n} months`;
      break;
    case "yearly":
      text = "Yearly";
      break;
  }
  if (amountType === "estimated") return `${text} · varies`;
  if (amountType === "statement") return `${text} · statement`;
  return text;
}

/** "every other Friday", "monthly": how a paycheck repeats, for the income tile caption. */
export function cadenceWords(schedule: Schedule): string {
  if (schedule.type === "every_n_weeks")
    return schedule.n === 2 ? `every other ${weekdayLong(schedule.dtstart)}` : `every ${schedule.n} weeks`;
  if (schedule.type === "every_n_months") return `every ${schedule.n} months`;
  if (schedule.type === "yearly") return "yearly";
  return "monthly";
}

type Source = "manual" | "csv" | "email" | "bank";

/** "Email", "Bank CSV", "Email + CSV", "Added by hand". */
export function sourceLabel(sources: readonly Source[]): string {
  const has = (s: Source) => sources.includes(s);
  if (has("email") && has("csv")) return "Email + CSV";
  if (has("email")) return "Email";
  if (has("csv")) return "Bank CSV";
  if (has("bank")) return "Bank";
  return "Added by hand";
}
