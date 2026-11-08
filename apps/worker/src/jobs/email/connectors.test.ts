// Pure parts of the connector jobs: what the sweep enqueues for a connection (table), and the look-back windows.
import { describe, expect, it } from "vitest";
import { daysBack, monthsBack, type Connection } from "./discover/connection";
import { jobsFor, pollMinutesFrom, POLL_MINUTES } from "./discover/sweep";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const base: Connection = {
  id: "11111111-1111-4111-8111-111111111111",
  householdId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  provider: "gmail",
  status: "active",
  sealed: { ciphertext: new Uint8Array(1), dekWrapped: new Uint8Array(1), keyId: "k" },
  syncCursor: "100",
  watchRef: null,
  watchExpiresAt: new Date(NOW + 5 * 86_400_000).toISOString(),
  pushReceivedAt: null,
  lastSyncedAt: minutesAgo(1),
  lastError: null,
  backfillMonths: 13,
  backfillStatus: "done",
  backfillCursor: null,
};

describe("jobsFor (what the sweep enqueues)", () => {
  const cases: [string, Partial<Connection>, string[]][] = [
    ["a healthy, recently checked connection needs nothing", {}, []],
    ["a push starts discover", { pushReceivedAt: minutesAgo(0) }, ["email.discover"]],
    [
      "no check for 15 minutes starts the fallback poll",
      { lastSyncedAt: minutesAgo(POLL_MINUTES) },
      ["email.discover"],
    ],
    ["14 minutes is not yet stale", { lastSyncedAt: minutesAgo(POLL_MINUTES - 1) }, []],
    ["never checked, with a cursor, is stale", { lastSyncedAt: null }, ["email.discover"]],
    [
      "no cursor yet: nothing to discover from",
      { syncCursor: null, lastSyncedAt: null, pushReceivedAt: minutesAgo(0) },
      [],
    ],
    [
      "a new connection backfills and starts its watch",
      { syncCursor: null, lastSyncedAt: null, watchExpiresAt: null, backfillStatus: "pending" },
      ["email.backfill", "email.watch.renew"],
    ],
    ["an unfinished backfill continues", { backfillStatus: "running" }, ["email.backfill"]],
    ["a finished backfill with no watch starts the watch", { watchExpiresAt: null }, ["email.watch.renew"]],
    [
      "a paused connection is left alone",
      { status: "paused", pushReceivedAt: minutesAgo(0), backfillStatus: "pending" },
      [],
    ],
    ["an errored connection waits for its owner", { status: "error", pushReceivedAt: minutesAgo(0) }, []],
    ["a disconnected mailbox that still holds a token is revoked", { status: "revoked" }, ["email.revoke"]],
    ["a disconnected mailbox whose token is gone is done", { status: "revoked", sealed: null }, []],
    ["an active connection without a token is skipped", { sealed: null, pushReceivedAt: minutesAgo(0) }, []],
  ];
  it.each(cases)("%s", (_name, over, expected) => {
    expect(jobsFor({ ...base, ...over }, NOW)).toEqual(expected);
  });
});

describe("look-back windows", () => {
  it("13 months back is about 395 days, calendar-correct at month ends", () => {
    expect(monthsBack("2026-11-09T12:00:00Z", 13)).toEqual({ sinceIso: "2025-10-09T12:00:00Z", days: 396 });
    expect(monthsBack("2026-03-31T00:00:00Z", 1).sinceIso).toBe("2026-02-28T00:00:00Z");
  });
  it("days back", () => {
    expect(daysBack("2026-11-09T12:00:00Z", 30)).toBe("2026-10-10T12:00:00Z");
  });
});

describe("polling interval (no Pub/Sub locally)", () => {
  it("EMAIL_POLL_MINUTES configures it, with a safe default", () => {
    expect(pollMinutesFrom({})).toBe(15);
    expect(pollMinutesFrom({ EMAIL_POLL_MINUTES: "5" })).toBe(5);
    for (const bad of ["0", "-1", "1.5", "abc", "99999", ""])
      expect(pollMinutesFrom({ EMAIL_POLL_MINUTES: bad })).toBe(15);
  });
  it("a shorter interval makes a connection stale sooner", () => {
    const c = { ...base, lastSyncedAt: minutesAgo(6) };
    expect(jobsFor(c, NOW)).toEqual([]);
    expect(jobsFor(c, NOW, 5)).toEqual(["email.discover"]);
  });
});
