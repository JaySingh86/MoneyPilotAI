import { parseDate } from "../dates";
import { riveraInput } from "../testing";
import type { EngineInput, ItemInput, RenewalInput } from "../types";
import {
  actBy,
  annualCents,
  isBigRenewal,
  nextDeadline,
  nextRenewal,
  renewalList,
  renewalRow,
  renewalsSummary,
} from "./renewals";

const asOf = parseDate("2026-10-27");

function renewal(r: Partial<RenewalInput>): RenewalInput {
  return {
    id: "r-x",
    name: "X",
    category: "insurance",
    owner: "m-sam",
    amountCents: 12000,
    every: { unit: "month", n: 12 },
    renewsOn: "2027-01-01",
    autoRenews: "yes",
    sources: ["email"],
    ...r,
  };
}

function sub(id: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    id,
    name: id,
    direction: "outflow",
    kind: "subscription",
    owner: "m-sam",
    amount: { type: "fixed", cents: 1000 },
    schedule: { type: "monthly_day", day: 10, dtstart: "2026-01-01" },
    ...patch,
  };
}

describe("renewal list", () => {
  it("is the fixture renewals plus the 7 subscription items (16)", () => {
    const list = renewalList(riveraInput());
    expect(list).toHaveLength(16);
    // r-car is linked to the car insurance item (BACKEND_PLAN §5.2: renewal_details extends an item), so
    // the item is not listed a second time and the count stays 16.
    expect(list.find((r) => r.id === "r-car")?.itemId).toBe("b-carins");
    expect(list.filter((r) => r.id === "b-carins")).toEqual([]);
    expect(list.filter((r) => r.itemId && r.id !== "r-car").map((r) => r.id)).toEqual([
      "b-stream",
      "b-news",
      "b-cloud",
      "b-musicf",
      "b-fit",
      "b-music2",
      "b-kids",
    ]);
    expect(list.find((r) => r.id === "b-stream")).toMatchObject({
      renewsOn: "2026-11-02",
      every: { unit: "month", n: 1 },
      previousAmountCents: 1999,
      priceChangedOn: "2026-09-28",
      sources: ["email"],
    });
  });

  it("skips items linked from a renewal, inactive ones and ones with no next occurrence", () => {
    const input: EngineInput = { ...riveraInput(), renewals: [renewal({ id: "r-news", itemId: "b-news" })] };
    input.items.push(
      sub("s-paused", { status: "paused" }),
      sub("s-ended", {
        schedule: { type: "monthly_day", day: 10, dtstart: "2026-01-01", until: "2026-10-01" },
      }),
      sub("s-inflow", { direction: "inflow" }),
    );
    const ids = renewalList(input).map((r) => r.id);
    expect(ids).toContain("r-news");
    expect(ids).not.toContain("b-news");
    expect(ids).not.toContain("s-paused");
    expect(ids).not.toContain("s-ended");
    expect(ids).not.toContain("s-inflow");
  });

  it("maps every schedule to a frequency, and defaults missing item fields", () => {
    const input: EngineInput = { ...riveraInput(), items: [], renewals: undefined };
    input.items.push(
      riveraInput().items[0] as ItemInput,
      sub("s-weeks", { schedule: { type: "every_n_weeks", n: 4, dtstart: "2026-10-30" } }),
      sub("s-months", { schedule: { type: "every_n_months", n: 3, dtstart: "2026-11-10" } }),
      sub("s-year", { schedule: { type: "yearly", dtstart: "2026-12-10" } }),
    );
    const list = renewalList(input);
    expect(list.map((r) => [r.id, r.every])).toEqual([
      ["s-weeks", { unit: "week", n: 4 }],
      ["s-months", { unit: "month", n: 3 }],
      ["s-year", { unit: "month", n: 12 }],
    ]);
    expect(list[0]).toMatchObject({
      sources: [],
      paidFrom: "account",
      previousAmountCents: null,
      priceChangeReviewed: false,
      markedPossiblyUnused: false,
      subcategory: null,
    });
  });
});

describe("renewal helpers (rule 11)", () => {
  it("annualizes by months or weeks", () => {
    expect(annualCents(68400, { unit: "month", n: 6 })).toBe(136800);
    expect(annualCents(2299, { unit: "month", n: 1 })).toBe(27588);
    expect(annualCents(1000, { unit: "week", n: 2 })).toBe(26000);
  });

  it("big = every 6 months or less often", () => {
    expect(isBigRenewal({ every: { unit: "month", n: 6 } })).toBe(true);
    expect(isBigRenewal({ every: { unit: "month", n: 3 } })).toBe(false);
    // 26 weeks is 6 months.
    expect(isBigRenewal({ every: { unit: "week", n: 26 } })).toBe(true);
    expect(isBigRenewal({ every: { unit: "week", n: 25 } })).toBe(false);
    expect(isBigRenewal({ every: { unit: "week", n: 52 } })).toBe(true);
  });

  it("rolls a past renewal date forward by its frequency", () => {
    expect(nextRenewal({ renewsOn: "2026-01-31", every: { unit: "month", n: 1 } }, asOf)).toBe("2026-10-31");
    expect(nextRenewal({ renewsOn: "2026-10-01", every: { unit: "week", n: 2 } }, asOf)).toBe("2026-10-29");
    expect(nextRenewal({ renewsOn: "2026-10-27", every: { unit: "month", n: 12 } }, asOf)).toBe("2026-10-27");
  });

  it("names the kind of the earliest deadline, a decision winning a tie", () => {
    expect(nextDeadline({ decisionBy: "2026-11-13", cancelBy: "2026-11-01" }, asOf)).toEqual({
      date: "2026-11-01",
      kind: "cancel",
    });
    expect(nextDeadline({ decisionBy: "2026-11-13", cancelBy: "2026-11-13" }, asOf)?.kind).toBe("decision");
    expect(nextDeadline({ decisionBy: "2026-10-01" }, asOf)).toBeNull();
    expect(renewalRow(renewal({ cancelBy: "2026-11-02" }), asOf).actByKind).toBe("cancel");
    expect(renewalRow(renewal({}), asOf).actByKind).toBeNull();
  });

  it("act-by is the earliest upcoming deadline", () => {
    expect(actBy({ decisionBy: "2026-11-13", cancelBy: "2026-11-01" }, asOf)).toBe("2026-11-01");
    expect(actBy({ decisionBy: "2026-10-01", cancelBy: null }, asOf)).toBeNull();
    expect(actBy({}, asOf)).toBeNull();
  });

  it("builds a row with shop-around, reminders and the price increase", () => {
    const row = renewalRow(
      renewal({ previousAmountCents: 10000, every: { unit: "month", n: 6 }, sources: ["manual"] }),
      asOf,
    );
    expect(row).toMatchObject({
      renewsOn: "2027-01-01",
      shopAroundOn: "2026-12-02",
      big: true,
      reminderOffsetsDays: [30, 7, 0],
      priceUp: true,
      annualIncreaseCents: 4000,
      nextActionOn: "2027-01-01",
      foundAutomatically: false,
      markedPossiblyUnused: false,
      itemId: null,
      decisionBy: null,
    });
    const monthly = renewalRow(renewal({ every: { unit: "month", n: 1 }, cancelBy: "2026-11-02" }), asOf);
    expect(monthly).toMatchObject({
      reminderOffsetsDays: [],
      priceUp: false,
      annualIncreaseCents: 0,
      nextActionOn: "2026-11-02",
    });
  });
});

describe("renewalsSummary (rule 11)", () => {
  it("sorts rows by the next action date and counts categories", () => {
    const s = renewalsSummary(riveraInput());
    expect(s.rows.slice(0, 3).map((r) => r.id)).toEqual(["b-stream", "r-car", "b-news"]);
    expect(s.countsByCategory).toEqual({ insurance: 5, subscription: 8, membership: 2, vehicle_home: 1 });
    expect(s.next90Days.ids).toEqual(["r-car", "r-av", "r-shop", "r-renters"]);
  });

  it("counts a plan decision only within 90 days and only for non-big items", () => {
    const input: EngineInput = {
      ...riveraInput(),
      items: riveraInput().items.filter((i) => i.kind !== "subscription"),
      renewals: [
        renewal({ id: "r-1", every: { unit: "month", n: 1 }, decisionBy: "2026-11-13" }),
        renewal({ id: "r-2", every: { unit: "month", n: 1 }, decisionBy: "2027-03-01" }),
        renewal({ id: "r-3", every: { unit: "month", n: 1 }, decisionBy: "2026-10-01" }),
        renewal({
          id: "r-4",
          every: { unit: "month", n: 12 },
          decisionBy: "2026-11-13",
          renewsOn: "2027-06-01",
        }),
        renewal({ id: "r-5", every: { unit: "month", n: 1 } }),
      ],
    };
    const s = renewalsSummary(input);
    expect(s.next90Days).toEqual({ count: 0, cents: 0, planDecisions: 1, ids: [] });
    expect(s.priceIncreaseYearlyCents).toBe(0);
    expect(s.couldSaveYearlyCents).toBe(0);
  });

  it("is empty for a household with no renewals", () => {
    const s = renewalsSummary({ ...riveraInput(), items: riveraInput().items.slice(0, 2), renewals: [] });
    expect(s).toMatchObject({ count: 0, yearlyCents: 0, monthlyAverageCents: 0, foundAutomatically: 0 });
  });
});
