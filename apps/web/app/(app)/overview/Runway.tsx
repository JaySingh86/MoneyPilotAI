"use client";

import { Card, RunwayChart } from "@mp/ui";
import type { RunwayDay } from "@mp/ui";
import type { PlanResponse } from "../../../lib/api/planning-types";
import { parseDate } from "../../../lib/format/dates";

/** One bar per day (§4.1). Each day's event is the net of what is scheduled on it, named by the API. */
function toDays(plan: PlanResponse): RunwayDay[] {
  return plan.runway.map((day) => {
    const net = day.events.reduce((sum, e) => sum + e.amountCents, 0);
    const result: RunwayDay = {
      date: parseDate(day.date),
      balanceCents: day.endBalanceCents,
      payday: day.events.some((e) => e.kind === "income"),
    };
    if (day.events.length > 0) {
      result.event = {
        label: plan.runwayLabels[day.date] ?? [...new Set(day.events.map((e) => e.name))].join(" & "),
        amountCents: net,
        estimate: day.events.some((e) => e.isEstimate),
      };
    }
    return result;
  });
}

export function Runway({ plan }: { plan: PlanResponse }) {
  return (
    <Card
      title="Cash runway to payday"
      subtitle="Projected balance after each scheduled bill and paycheck. Day-to-day spending not included."
    >
      <RunwayChart
        days={toDays(plan)}
        lowestDate={plan.lowest.date}
        cushionCents={plan.cushionCents}
        today={parseDate(plan.asOf)}
      />
    </Card>
  );
}
