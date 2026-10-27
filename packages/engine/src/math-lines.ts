// "See the math" rows (DESIGN_SPEC §4 math breakdown, §5.1 hero breakdown). Raw values only; the UI
// formats them through packages/format, and AI text may quote only these numbers.
import { compareStrings } from "./dates";
import { sumCents } from "./money";
import type { SafeToSpend } from "./safe-to-spend";
import type { Cents, IsoDate, MathLine, PlanningWindow, Runway } from "./types";

export interface MathLinesInput {
  runway: Runway;
  window: PlanningWindow;
  lowest: { date: IsoDate; balanceCents: Cents };
  cushionCents: Cents;
  safe: SafeToSpend;
  perDayCents: Cents | null;
}

const line = (l: Partial<MathLine> & Pick<MathLine, "id" | "label" | "role">): MathLine => ({
  cents: null,
  days: null,
  date: null,
  ...l,
});

/**
 * Starting balance + carried events + income − money out (through the lowest day) = lowest point;
 * lowest − cushion = safe to spend (or the gap); then days to payday and per day.
 */
export function mathLines(m: MathLinesInput): MathLine[] {
  const upToLowest = m.runway.days
    .filter((d) => compareStrings(d.date, m.lowest.date) <= 0)
    .flatMap((d) => d.events.map((e) => e.amountCents));
  const income = sumCents(upToLowest.filter((c) => c > 0));
  const out = -sumCents(upToLowest.filter((c) => c < 0));
  const carried = sumCents(m.runway.carriedEvents.map((e) => e.amountCents));

  const lines: MathLine[] = [
    line({
      id: "starting_balance",
      label: "Latest balance",
      role: "value",
      cents: m.runway.startingBalanceCents,
      date: m.runway.startingBalanceAsOf,
    }),
  ];
  if (m.runway.carriedEvents.length > 0) {
    lines.push(
      line({ id: "carried_events", label: "Not yet in that balance", role: "value", cents: carried }),
    );
  }
  lines.push(
    line({ id: "income_in_window", label: "Income through the lowest day", role: "value", cents: income }),
    line({
      id: "money_out_in_window",
      label: "Bills and planned spending through the lowest day",
      role: "subtract",
      cents: out,
    }),
    line({
      id: "lowest_point",
      label: "Lowest projected balance",
      role: "value",
      cents: m.lowest.balanceCents,
      date: m.lowest.date,
    }),
    line({ id: "cushion", label: "Cushion", role: "subtract", cents: m.cushionCents }),
  );
  if (m.safe.state === "shortfall") {
    lines.push(line({ id: "shortfall", label: "Short", role: "gap", cents: -m.safe.safeToSpendCents }));
  } else {
    lines.push(
      line({ id: "safe_to_spend", label: "Safe to spend", role: "total", cents: m.safe.safeToSpendCents }),
    );
  }
  lines.push(
    line({
      id: "days_to_payday",
      label: "Days to payday",
      role: "value",
      days: m.window.daysToPayday,
      date: m.window.to,
    }),
  );
  if (m.perDayCents !== null) {
    lines.push(line({ id: "per_day", label: "Per day", role: "value", cents: m.perDayCents }));
  }
  return lines;
}
