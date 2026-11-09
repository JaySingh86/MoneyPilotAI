// The cost caps (security review B1): their defaults, how the environment sets them, and the budget arithmetic.
import { describe, expect, it } from "vitest";
import { clearsNewSenderBar } from "./gate";
import { DEFAULT_LIMITS, budgetOf, limitsFromEnv, localDayStart } from "./limits";

describe("limitsFromEnv", () => {
  it("defaults: 100 calls a day per household, 20 for new senders, 500 backfill messages, a stricter score of 5", () => {
    expect(limitsFromEnv({})).toEqual({
      dailyPerHousehold: 100,
      dailyNewSenders: 20,
      backfillMax: 500,
      newSenderMinScore: 5,
    });
    expect(DEFAULT_LIMITS.dailyPerHousehold).toBe(100);
  });

  it("reads the four environment keys", () => {
    expect(
      limitsFromEnv({
        AI_EXTRACT_DAILY_CAP_PER_HOUSEHOLD: "40",
        AI_EXTRACT_DAILY_CAP_NEW_SENDERS: "5",
        AI_BACKFILL_MAX_MESSAGES: "120",
        EMAIL_NEW_SENDER_MIN_SCORE: "6",
      }),
    ).toEqual({ dailyPerHousehold: 40, dailyNewSenders: 5, backfillMax: 120, newSenderMinScore: 6 });
  });

  it("zero is a real cap (nothing is extracted); a typo or a negative never lifts a cap", () => {
    expect(limitsFromEnv({ AI_EXTRACT_DAILY_CAP_PER_HOUSEHOLD: "0" }).dailyPerHousehold).toBe(0);
    for (const bad of ["abc", "-5", "1.5", "1e9", " "]) {
      expect(limitsFromEnv({ AI_EXTRACT_DAILY_CAP_PER_HOUSEHOLD: bad }).dailyPerHousehold).toBe(100);
    }
  });
});

describe("budgetOf", () => {
  const limits = { ...DEFAULT_LIMITS, dailyPerHousehold: 3, dailyNewSenders: 1 };

  it("spends one call per take and refuses at the daily cap", () => {
    const b = budgetOf(limits, 0, 0);
    expect([b.take(false), b.take(false), b.take(false), b.take(false)]).toEqual([
      "ok",
      "ok",
      "ok",
      "daily_cap",
    ]);
    expect(b.used).toBe(3);
  });

  it("the new-sender sub-cap is smaller and does not stop known senders", () => {
    const b = budgetOf(limits, 0, 0);
    expect(b.take(true)).toBe("ok");
    expect(b.take(true)).toBe("new_sender_cap");
    expect(b.take(false)).toBe("ok");
    expect(b.used).toBe(2);
    expect(b.newUsed).toBe(1);
  });

  it("peek spends nothing; a refused take spends nothing", () => {
    const b = budgetOf(limits, 2, 0);
    expect(b.peek(false)).toBe("ok");
    expect(b.peek(false)).toBe("ok");
    expect(b.used).toBe(2);
    expect(b.take(false)).toBe("ok");
    expect(b.take(false)).toBe("daily_cap");
    expect(b.used).toBe(3);
  });

  it("starts from what was already spent today", () => {
    expect(budgetOf(limits, 3, 0).peek(false)).toBe("daily_cap");
    expect(budgetOf(limits, 0, 1).peek(true)).toBe("new_sender_cap");
  });
});

describe("localDayStart", () => {
  it("is household-local midnight as a UTC instant, across daylight saving", () => {
    expect(localDayStart("2026-10-27T15:00:00Z", "America/New_York")).toBe("2026-10-27T04:00:00Z");
    expect(localDayStart("2026-11-02T03:00:00Z", "America/New_York")).toBe("2026-11-01T04:00:00Z");
    expect(localDayStart("2026-11-02T06:00:00Z", "America/New_York")).toBe("2026-11-02T05:00:00Z");
  });
});

describe("the stricter bar for a never-seen sender", () => {
  const limits = DEFAULT_LIMITS;
  it("one bill word is not enough, two are", () => {
    expect(clearsNewSenderBar("Your statement is ready", "new.example", limits)).toBe(false);
    expect(clearsNewSenderBar("Your statement is ready: payment due soon", "new.example", limits)).toBe(true);
    expect(clearsNewSenderBar("50% off everything, hurry", "new.example", limits)).toBe(false);
  });
  it("the score is configurable", () => {
    expect(
      clearsNewSenderBar("Your statement is ready", "new.example", { ...limits, newSenderMinScore: 3 }),
    ).toBe(true);
  });
});
