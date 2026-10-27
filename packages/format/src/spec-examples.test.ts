// Every example in DESIGN_SPEC §7 ("Content & formatting") as a test case.
// If one of these fails, the formatter is wrong; never change the expected strings
// without a spec change.
import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { date, estimateRange, maskEmail, maskLast4, money, relative, shortfall } from "./index";

const today = Temporal.PlainDate.from("2026-10-27"); // fixture `today`

describe("DESIGN_SPEC §7 examples", () => {
  it("money in tables, lists and detail: $2,150.00", () => {
    expect(money(215000, { mode: "detail" })).toBe("$2,150.00");
  });

  it("money in hero and KPI tiles: whole dollars $1,007", () => {
    expect(money(100701, { mode: "headline" })).toBe("$1,007");
  });

  it("hero rounding: spendable money down, shortfalls up, summaries nearest", () => {
    expect(money(100701, { mode: "headline" })).toBe("$1,007");
    expect(shortfall(-79299)).toBe("$793 short");
    // Renewals: "about $566 a month".
    expect(`about ${money(56560, { mode: "headline", rounding: "nearest" })} a month`).toBe(
      "about $566 a month",
    );
  });

  it("bill totals keep cents: $4,792.99", () => {
    // Bill totals in a hero/KPI use the detail format (cents kept).
    expect(money(479299, { mode: "detail" })).toBe("$4,792.99");
  });

  it("outflow sign uses U+2212: −$389.00", () => {
    const out = money(-38900, { mode: "signed" });
    expect(out).toBe("−$389.00");
    expect(out.codePointAt(0)).toBe(0x2212);
  });

  it("income sign: +$2,900.00", () => {
    expect(money(290000, { mode: "signed" })).toBe("+$2,900.00");
  });

  it("bill tables have no sign: $389.00", () => {
    expect(money(38900, { mode: "detail" })).toBe("$389.00");
  });

  it("calendar chips and per-year changes: +$3,150 · −$1,263 · −$22.99 · +$55 / yr", () => {
    expect(money(315000, { mode: "chip" })).toBe("+$3,150");
    expect(money(-126299, { mode: "chip" })).toBe("−$1,263");
    expect(money(-2299, { mode: "chip" })).toBe("−$22.99");
    expect(`${money(5500, { mode: "chip" })} / yr`).toBe("+$55 / yr");
  });

  it("estimates: ~$142.00", () => {
    expect(money(14200, { mode: "estimate" })).toBe("~$142.00");
  });

  it("in signed lists the sign follows the ~: ~−$142.00", () => {
    expect(money(-14200, { mode: "estimate" })).toBe("~−$142.00");
  });

  it("estimate range chip: Estimate ±$30", () => {
    expect(estimateRange(3000, { label: true })).toBe("Estimate ±$30");
    expect(estimateRange(3000)).toBe("±$30");
  });

  it("dates in the current year: Nov 4", () => {
    expect(date(Temporal.PlainDate.from("2026-11-04"), { relativeTo: today })).toBe("Nov 4");
  });

  it("dates in another year: Jan 9, 2027", () => {
    expect(date(Temporal.PlainDate.from("2027-01-09"), { relativeTo: today })).toBe("Jan 9, 2027");
  });

  it("weekday where timing matters: Wed, Nov 4", () => {
    expect(date(Temporal.PlainDate.from("2026-11-04"), { relativeTo: today, weekday: true })).toBe(
      "Wed, Nov 4",
    );
  });

  it("relative time is secondary: in 8 days", () => {
    expect(relative(8)).toBe("in 8 days");
    expect([0, 1, 8, -1, -3].map(relative)).toEqual([
      "today",
      "tomorrow",
      "in 8 days",
      "yesterday",
      "3 days ago",
    ]);
    const nov4 = Temporal.PlainDate.from("2026-11-04");
    expect(`${date(nov4, { relativeTo: today, weekday: true })} · ${relative(today.until(nov4).days)}`).toBe(
      "Wed, Nov 4 · in 8 days",
    );
  });

  it("masking last 4 digits: •••4821", () => {
    expect(maskLast4("4821")).toBe("•••4821");
  });

  it("emails show at most 3 characters and always hide one: sam•••@gmail.com · sa•••@x.com · j•••@x.com", () => {
    expect(maskEmail("samantha@gmail.com")).toBe("sam•••@gmail.com");
    expect(maskEmail("sam@x.com")).toBe("sa•••@x.com");
    expect(maskEmail("jo@x.com")).toBe("j•••@x.com");
    expect(maskEmail("x@x.com")).toBe("•••@x.com");
  });

  it("shortfall: $793 short (WP-04, DESIGN_SPEC §6 rule 4)", () => {
    expect(shortfall(-79299)).toBe("$793 short");
  });
});
