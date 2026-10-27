// DST and timezone behavior (BACKEND_PLAN §7.2): households in America/Los_Angeles and Pacific/Honolulu,
// around the November 2026 and March 2027 DST changes. Bill dates are PlainDate, so the clock never
// shifts a bill by a day; only the instant → household date conversion depends on the zone.
import { householdDate, parseDate } from "./dates";
import { EngineError } from "./errors";
import { computePlan } from "./plan";
import { riveraInput } from "./testing";
import type { EngineInput } from "./types";

const LA = "America/Los_Angeles";
const HNL = "Pacific/Honolulu";

describe("householdDate: UTC instant → household-local date", () => {
  it.each([
    // Los Angeles, DST ends Sun Nov 1 2026 at 02:00 PDT (09:00Z).
    [LA, "2026-11-01T06:59:59Z", "2026-10-31"],
    [LA, "2026-11-01T07:00:00Z", "2026-11-01"],
    [LA, "2026-11-01T09:30:00Z", "2026-11-01"], // 01:30 PST, the repeated hour
    [LA, "2026-11-02T07:59:59Z", "2026-11-01"], // 23:59:59 PST
    [LA, "2026-11-02T08:00:00Z", "2026-11-02"],
    // Los Angeles, DST starts Sun Mar 14 2027 at 02:00 PST (10:00Z).
    [LA, "2027-03-14T07:59:59Z", "2027-03-13"],
    [LA, "2027-03-14T08:00:00Z", "2027-03-14"],
    [LA, "2027-03-15T06:59:59Z", "2027-03-14"], // 23:59:59 PDT
    [LA, "2027-03-15T07:00:00Z", "2027-03-15"],
    // Honolulu is UTC−10 all year: no DST.
    [HNL, "2026-11-01T09:59:59Z", "2026-10-31"],
    [HNL, "2026-11-01T10:00:00Z", "2026-11-01"],
    [HNL, "2027-03-14T09:59:59Z", "2027-03-13"],
    [HNL, "2027-03-14T10:00:00Z", "2027-03-14"],
    // An offset instant.
    [LA, "2026-10-27T23:30:00-07:00", "2026-10-27"],
  ])("%s %s → %s", (zone, instant, date) => {
    expect(householdDate(instant, zone)).toBe(date);
  });

  it("gives the two households different dates for the same instant", () => {
    const instant = "2026-11-01T09:59:59Z";
    expect(householdDate(instant, LA)).toBe("2026-11-01");
    expect(householdDate(instant, HNL)).toBe("2026-10-31");
  });

  it("rejects an unknown zone or an instant without an offset", () => {
    expect(() => householdDate("2026-11-01T00:00:00Z", "Not/AZone")).toThrow(EngineError);
    expect(() => householdDate("2026-11-01T00:00:00", LA)).toThrow(EngineError);
  });
});

function marchHousehold(timezone: string): EngineInput {
  // Sam's biweekly pay continues from Nov 6 2026: …, Mar 12, Mar 26 2027. Today Sat Mar 13 2027.
  const base = riveraInput({ timezone });
  return { ...base, asOf: "2027-03-13", startingBalance: { cents: 250000, asOf: "2027-03-13" } };
}

describe("plans across DST changes", () => {
  it.each([LA, HNL])("November 2026 (%s): one runway day per calendar day, 10 days to payday", (zone) => {
    const plan = computePlan(riveraInput({ timezone: zone }));
    expect(plan.window.daysToPayday).toBe(10);
    const dates = plan.runway.map((d) => d.date);
    expect(dates).toHaveLength(11);
    dates.forEach((d, i) => expect(d).toBe(parseDate("2026-10-27").add({ days: i }).toString()));
    // Rent on the DST day (Sun Nov 1) lands on Nov 1, once.
    const rent = plan.runway.flatMap((d) => d.events).filter((e) => e.sourceId === "b-rent");
    expect(rent.map((e) => e.date)).toEqual(["2026-11-01"]);
  });

  it.each([LA, HNL])("March 2027 (%s): the window crosses Mar 14 with no lost or doubled day", (zone) => {
    const plan = computePlan(marchHousehold(zone));
    expect(plan.window).toEqual({ from: "2027-03-13", to: "2027-03-26", daysToPayday: 13 });
    const dates = plan.runway.map((d) => d.date);
    expect(new Set(dates).size).toBe(14);
    expect(dates).toContain("2027-03-14");
    // Jordan's pay on the last Friday (Mar 26) coincides with Sam's payday.
    expect(plan.runway.at(-1)?.events.map((e) => e.sourceId)).toEqual(["inc-jordan", "inc-sam"]);
  });

  it("the same household gives the same plan in either zone", () => {
    expect(computePlan(riveraInput({ timezone: HNL }))).toEqual(computePlan(riveraInput({ timezone: LA })));
    expect(computePlan(marchHousehold(HNL))).toEqual(computePlan(marchHousehold(LA)));
  });

  it("does not depend on the server's process timezone", () => {
    const original = process.env.TZ;
    try {
      const results = ["UTC", LA, HNL, "Asia/Tokyo"].map((tz) => {
        process.env.TZ = tz;
        return [computePlan(riveraInput()), computePlan(marchHousehold(LA))];
      });
      for (const r of results) expect(r).toEqual(results[0]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
