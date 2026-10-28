// Runway inputs built from the golden fixture, for stories and tests only.
// Balances, the lowest day and the cushion are the fixture's `expected` values (engine output).
// Event labels mirror the canvas ("Rent −2,150"); each event amount is that day's net change.
import { Temporal } from "@js-temporal/polyfill";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import type { RunwayDay } from "../runway-chart/RunwayChart";

type EventName = { label: string; estimate?: boolean };

const NORMAL_EVENTS: Record<string, EventName> = {
  "2026-10-29": { label: "Car" },
  "2026-10-30": { label: "Pay" },
  "2026-10-31": { label: "Phone" },
  "2026-11-01": { label: "Rent" },
  "2026-11-02": { label: "Daycare & TV" },
  "2026-11-03": { label: "Power", estimate: true },
  "2026-11-04": { label: "Insurance" },
  "2026-11-05": { label: "Internet" },
  "2026-11-06": { label: "Pay" },
};

const SHORTFALL_EVENTS: Record<string, EventName> = {
  ...NORMAL_EVENTS,
  "2026-10-28": { label: "Repair" },
};

// Income days in the window: Jordan's pay (last Friday, Oct 30) and Sam's pay (Nov 6).
const PAYDAYS = new Set(["2026-10-30", "2026-11-06"]);

function toDays(runway: Record<string, number>, events: Record<string, EventName>): RunwayDay[] {
  const entries = Object.entries(runway).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([iso, balanceCents], i) => {
    const previous = i > 0 ? entries[i - 1]?.[1] : undefined;
    const name = events[iso];
    const day: RunwayDay = {
      date: Temporal.PlainDate.from(iso),
      balanceCents,
      payday: PAYDAYS.has(iso),
    };
    if (name !== undefined && previous !== undefined) {
      day.event = { label: name.label, amountCents: balanceCents - previous, estimate: name.estimate };
    }
    return day;
  });
}

export const fixtureToday = Temporal.PlainDate.from(fixture.today);
export const fixtureCushionCents = fixture.household.cushionCents;

export const normalRunway = {
  days: toDays(fixture.expected.runwayEndOfDayCents, NORMAL_EVENTS),
  lowestDate: fixture.expected.lowest.date,
  lowestCents: fixture.expected.lowest.balanceCents,
};

export const shortfallRunway = {
  days: toDays(fixture.scenarios.shortfall.expected.runwayEndOfDayCents, SHORTFALL_EVENTS),
  lowestDate: fixture.scenarios.shortfall.expected.lowest.date,
  lowestCents: fixture.scenarios.shortfall.expected.lowest.balanceCents,
};
