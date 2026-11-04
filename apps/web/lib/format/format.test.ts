import { describe, expect, it } from "vitest";
import {
  addMonths,
  longWeekdayShortDate,
  monthTitle,
  monthYear,
  overlineDate,
  shortDate,
  shortDateWithYear,
} from "./dates";
import { dateRange, shortfallCaption } from "./text";
import { fillTemplate } from "./templates";

const today = "2026-10-27";

describe("dates", () => {
  it("formats the canvas headings", () => {
    expect(overlineDate(today)).toBe("Tuesday, October 27");
    expect(longWeekdayShortDate("2026-11-06")).toBe("Friday, Nov 6");
    expect(monthTitle("2026-11")).toBe("November 2026");
    expect(monthYear("2027-10")).toBe("Oct 2027");
    expect(shortDateWithYear("2026-10-26")).toBe("Oct 26, 2026");
  });

  it("follows §7: no year in the current year, otherwise the year", () => {
    expect(shortDate("2026-11-04", today)).toBe("Nov 4");
    expect(shortDate("2026-11-04", today, { weekday: true })).toBe("Wed, Nov 4");
    expect(shortDate("2027-01-09", today)).toBe("Jan 9, 2027");
    expect(shortDate("2027-03-01", today)).toBe("Mar 1, 2027");
  });

  it("moves months across years", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
});

describe("shortfall caption", () => {
  it("names the dates below the cushion and below $0", () => {
    expect(
      shortfallCaption({
        asOf: today,
        belowCushionFrom: "2026-11-03",
        belowZeroDates: ["2026-11-04", "2026-11-05"],
      }),
    ).toBe("Below your cushion from Nov 3, below $0 on Nov 4–5");
    expect(dateRange(["2026-11-30", "2026-12-02"], today)).toBe("Nov 30–Dec 2");
    expect(dateRange(["2026-11-04"], today)).toBe("Nov 4");
  });
});

describe("decision templates", () => {
  it("fills the engine's car insurance card with formatted money and dates", () => {
    const params = {
      name: "Car insurance renewal",
      amountCents: 68400,
      dueOn: "2026-11-04",
      everyMonths: 6,
      altDate: "2026-11-06",
      altSafeToSpendCents: 169101,
    };
    expect(fillTemplate("{name}, {amountCents} on {dueOn}", params, today)).toBe(
      "Car insurance renewal, $684 on Nov 4",
    );
    expect(
      fillTemplate(
        "Paying on {altDate} instead changes safe to spend to {altSafeToSpendCents}.",
        params,
        today,
      ),
    ).toBe("Paying on Nov 6 instead changes safe to spend to $1,691.");
  });

  it("fills the estimate and goal cards", () => {
    expect(
      fillTemplate(
        "{name} is about {amountCents} (±{rangeCents})",
        { name: "Electricity", amountCents: 14200, rangeCents: 3000 },
        today,
      ),
    ).toBe("Electricity is about $142 (±$30)");
    expect(
      fillTemplate(
        "At {monthlyCents} a month you’ll have {projectedCents} by {targetDate}. Raising it to {suggestedMonthlyCents}.",
        {
          monthlyCents: 25000,
          projectedCents: 215000,
          targetDate: "2027-03-01",
          suggestedMonthlyCents: 31300,
        },
        today,
      ),
    ).toBe("At $250 a month you’ll have $2,150 by Mar 1, 2027. Raising it to $313.");
  });

  it("formats a negative lowest balance and the shortfall", () => {
    expect(
      fillTemplate(
        "Short {shortfallCents}; lowest {lowestCents} on {lowestOn}",
        {
          shortfallCents: 79300,
          lowestCents: -29299,
          lowestOn: "2026-11-05",
        },
        today,
      ),
    ).toBe("Short $793; lowest −$293 on Nov 5");
  });

  it("leaves unknown placeholders visible rather than inventing a value", () => {
    expect(fillTemplate("{missing}", {}, today)).toBe("{missing}");
  });
});
