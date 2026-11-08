import { describe, expect, it } from "vitest";
import { agoLabel, localDate, parseDollars, timestampLabel } from "./input";

describe("parseDollars", () => {
  it("parses plain dollar amounts to integer cents", () => {
    expect(parseDollars("$500")).toBe(50000);
    expect(parseDollars("151.37")).toBe(15137);
    expect(parseDollars("$1,234.5")).toBe(123450);
    expect(parseDollars("  $2,150.00 ")).toBe(215000);
    expect(parseDollars("0.07")).toBe(7);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "abc", "-5", "1.234", "$1,23", "1e3", "$"]) expect(parseDollars(bad)).toBeNull();
  });
});

describe("timestamps in the household time zone", () => {
  it("turns UTC into local dates and times", () => {
    expect(localDate("2026-10-27T01:40:00Z", "America/New_York")).toBe("2026-10-26");
    expect(timestampLabel("2026-10-27T12:58:00Z", "America/New_York")).toBe("Oct 27, 8:58 AM");
    expect(timestampLabel("2026-10-27T01:40:00Z", "America/New_York")).toBe("Oct 26, 9:40 PM");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-27T13:00:00Z");
    expect(agoLabel("2026-10-27T12:48:00Z", now)).toBe("12 min ago");
    expect(agoLabel("2026-10-27T10:00:00Z", now)).toBe("3 hours ago");
    expect(agoLabel("2026-10-25T13:00:00Z", now)).toBe("2 days ago");
    expect(agoLabel("2026-10-27T13:00:00Z", now)).toBe("just now");
  });
});
