import { describe, expect, it } from "vitest";
import { daysBetween, defaultOffsets, isMonthlySubscription, reminderDedupeKey, reminderSendAt } from "./schedule";

const NY = "America/New_York";

describe("reminderSendAt: 09:00 household-local across the Nov 1, 2026 fall-back", () => {
  it("on the day of the change, 09:00 is EST (UTC-5)", () => {
    expect(reminderSendAt("2026-11-01", 0, NY)).toBe("2026-11-01T14:00:00Z");
  });
  it("the day before, 09:00 is still EDT (UTC-4)", () => {
    expect(reminderSendAt("2026-11-02", 2, NY)).toBe("2026-10-31T13:00:00Z");
    expect(reminderSendAt("2026-11-01", 1, NY)).toBe("2026-10-31T13:00:00Z");
  });
  it("an offset that crosses the change lands on 09:00 local, not 24 h earlier", () => {
    // due Nov 3, 3 days before = Oct 31 09:00 EDT; due Nov 4, 3 days before = Nov 1 09:00 EST
    expect(reminderSendAt("2026-11-03", 3, NY)).toBe("2026-10-31T13:00:00Z");
    expect(reminderSendAt("2026-11-04", 3, NY)).toBe("2026-11-01T14:00:00Z");
  });
  it("30 days before crosses it too", () => {
    expect(reminderSendAt("2026-11-30", 30, NY)).toBe("2026-10-31T13:00:00Z");
  });
  it("follows the household zone, not the server's", () => {
    expect(reminderSendAt("2026-11-01", 0, "America/Chicago")).toBe("2026-11-01T15:00:00Z");
    expect(reminderSendAt("2026-11-01", 0, "America/Los_Angeles")).toBe("2026-11-01T17:00:00Z");
    // Arizona has no daylight saving
    expect(reminderSendAt("2026-07-01", 0, "America/Phoenix")).toBe("2026-07-01T16:00:00Z");
  });
  it("spring forward: Mar 8, 2026", () => {
    expect(reminderSendAt("2026-03-08", 0, NY)).toBe("2026-03-08T13:00:00Z");
    expect(reminderSendAt("2026-03-08", 1, NY)).toBe("2026-03-07T14:00:00Z");
  });
  it("rejects a negative or fractional offset", () => {
    expect(() => reminderSendAt("2026-11-01", -1, NY)).toThrow(RangeError);
    expect(() => reminderSendAt("2026-11-01", 1.5, NY)).toThrow(RangeError);
  });
});

describe("keys and defaults", () => {
  it("the dedupe key is (item, rule date, offset, recipient)", () => {
    expect(reminderDedupeKey({ itemId: "i", scheduledOn: "2026-11-06", offsetDays: 3, userId: "u" })).toBe(
      "reminder:i:2026-11-06:3:u",
    );
  });
  it("3 and 0 for ordinary bills, 30, 7 and 0 for yearly or 6-monthly ones", () => {
    expect(defaultOffsets("FREQ=MONTHLY;BYMONTHDAY=1")).toEqual([3, 0]);
    expect(defaultOffsets("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1")).toEqual([3, 0]);
    expect(defaultOffsets("FREQ=MONTHLY;INTERVAL=6")).toEqual([30, 7, 0]);
    expect(defaultOffsets("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3")).toEqual([30, 7, 0]);
    expect(defaultOffsets("FREQ=WEEKLY")).toEqual([3, 0]);
  });
  it("a monthly subscription is monthly cadence (every month) in the subscription category (Q-134)", () => {
    expect(isMonthlySubscription("FREQ=MONTHLY;BYMONTHDAY=5", "subscription")).toBe(true);
    expect(isMonthlySubscription("FREQ=MONTHLY", "subscription")).toBe(true);
    expect(isMonthlySubscription("FREQ=MONTHLY;INTERVAL=1", "subscription")).toBe(true);
    expect(isMonthlySubscription("FREQ=MONTHLY;BYMONTHDAY=5", "housing")).toBe(false);
    expect(isMonthlySubscription("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3", "subscription")).toBe(false);
    expect(isMonthlySubscription("FREQ=MONTHLY;INTERVAL=6", "subscription")).toBe(false);
    expect(isMonthlySubscription("FREQ=MONTHLY;INTERVAL=3", "subscription")).toBe(false);
  });
  it("counts calendar days", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(daysBetween("2026-11-02", "2026-11-02")).toBe(0);
  });
});
