// WP-16 acceptance at the package level: 13 months of synthetic bank exports for the Rivera household detect
// every monthly bill, both paychecks, car insurance (6 months) and water (quarterly) with the right amount types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRiveraCsvs, type RiveraFixtureSlice } from "../testing/rivera-csv";
import {
  candidateFields,
  decodeCsvBytes,
  detectRecurring,
  matchExistingItem,
  normalizeMerchant,
  normalizeRows,
  parseCsv,
  suggestMapping,
  type ColumnMapping,
  type RecurringCandidate,
} from "./index";

const fixture = JSON.parse(
  readFileSync(new URL("../../../design/fixtures/rivera-household.json", import.meta.url), "utf8"),
) as RiveraFixtureSlice & { today: string };

const ASOF = fixture.today;
const csvs = buildRiveraCsvs(fixture, ASOF);

const SAM: ColumnMapping = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  balance: "Running Bal.",
  amountSign: "outflow_negative",
};
const JORDAN: ColumnMapping = {
  date: "Posted",
  description: "Payee",
  debit: "Withdrawals",
  credit: "Deposits",
  account: "Account",
  amountSign: "outflow_negative",
};

function detectAll(): RecurringCandidate[] {
  const sam = normalizeRows(parseCsv(csvs.sam).rows, SAM);
  const jordan = normalizeRows(parseCsv(csvs.jordan).rows, JORDAN);
  return detectRecurring([...sam.transactions, ...jordan.transactions], ASOF);
}

const find = (all: RecurringCandidate[], id: string) => {
  const key = normalizeMerchant(csvs.descriptions[id] ?? "");
  return all.find((c) => c.merchantNorm === key);
};

describe("synthetic 13-month CSVs for the fixture household", () => {
  const all = detectAll();

  const monthlyFixed = [
    "b-car",
    "b-phone",
    "b-rent",
    "b-daycare",
    "b-stream",
    "b-internet",
    "b-news",
    "b-cloud",
    "b-musicf",
    "b-fit",
    "b-music2",
    "b-kids",
  ];
  it.each(monthlyFixed)("%s is a fixed monthly bill with the fixture amount", (id) => {
    const bill = fixture.bills.find((b) => b.id === id);
    const c = find(all, id);
    expect(c, id).toBeDefined();
    expect(c?.cadence).toBe("monthly");
    expect(c?.direction).toBe("outflow");
    expect(c?.amountType).toBe("fixed");
    expect(c?.amountCents).toBe(bill?.amountCents);
  });

  it.each(["b-power", "b-card"])("%s is monthly with an estimated amount", (id) => {
    const c = find(all, id);
    expect(c?.cadence).toBe("monthly");
    expect(c?.amountType).toBe("estimated");
    expect(candidateFields(c as RecurringCandidate).amountDueCents).toBeNull();
  });

  it("finds the monthly schedule days: rent on the 1st, phone on the last day, car on the 29th", () => {
    expect(find(all, "b-rent")?.schedule).toEqual({ kind: "monthly_day", day: 1 });
    expect(find(all, "b-phone")?.schedule).toEqual({ kind: "monthly_last_day" });
    expect(find(all, "b-car")?.schedule).toEqual({ kind: "monthly_day", day: 29 });
  });

  it("finds car insurance every 6 months and water and trash quarterly, both fixed, with the next date", () => {
    const ins = find(all, "b-carins");
    expect(ins).toMatchObject({
      cadence: "every_6_months",
      amountType: "fixed",
      amountCents: 68400,
      nextExpected: "2026-11-04",
    });
    const water = find(all, "b-water");
    expect(water).toMatchObject({
      cadence: "quarterly",
      amountType: "fixed",
      amountCents: 9600,
      nextExpected: "2026-11-18",
    });
  });

  it("finds Sam's biweekly paycheck and Jordan's last-Friday paycheck as fixed inflows", () => {
    const sam = find(all, "inc-sam");
    expect(sam).toMatchObject({
      direction: "inflow",
      kind: "paycheck",
      cadence: "biweekly",
      amountType: "fixed",
      amountCents: 315000,
    });
    expect(sam?.schedule).toEqual({ kind: "biweekly", weekday: 5 });
    expect(sam?.nextExpected).toBe("2026-11-06");
    const jordan = find(all, "inc-jordan");
    expect(jordan).toMatchObject({
      direction: "inflow",
      kind: "paycheck",
      cadence: "monthly",
      amountType: "fixed",
      amountCents: 290000,
    });
    expect(jordan?.schedule).toEqual({ kind: "monthly_last_weekday", weekday: 5 });
    expect(jordan?.nextExpected).toBe("2026-10-30");
  });

  it("detects exactly the fixture's items: no noise merchant becomes a bill", () => {
    expect(all).toHaveLength(fixture.bills.length + fixture.incomes.length);
  });

  it("reads the balance column of the file that has one", () => {
    const sam = normalizeRows(parseCsv(csvs.sam).rows, SAM);
    expect(sam.latestBalance?.cents).toBe(csvs.samBalanceCents);
    expect((sam.latestBalance?.on ?? "9999") <= ASOF).toBe(true);
    expect(normalizeRows(parseCsv(csvs.jordan).rows, JORDAN).latestBalance).toBeNull();
  });

  it("keeps only the last 4 of the account column", () => {
    const jordan = normalizeRows(parseCsv(csvs.jordan).rows, JORDAN);
    expect(new Set(jordan.transactions.map((t) => t.accountLast4))).toEqual(new Set(["4821"]));
  });

  it("is deterministic", () => {
    expect(buildRiveraCsvs(fixture, ASOF)).toEqual(csvs);
  });

  it("matches a candidate to an item we already track, and says duplicate when the fixed amount is the same", () => {
    const rent = find(all, "b-rent") as RecurringCandidate;
    const base = { providerName: null, direction: "outflow" as const, amountType: "fixed" as const };
    expect(
      matchExistingItem(rent, [{ ...base, id: "i1", name: "Oakwood Apartments rent", amountCents: 215000 }]),
    ).toEqual({ itemId: "i1", type: "duplicate" });
    expect(
      matchExistingItem(rent, [{ ...base, id: "i1", name: "Oakwood Apartments rent", amountCents: 210000 }]),
    ).toEqual({ itemId: "i1", type: "update" });
    expect(matchExistingItem(rent, [{ ...base, id: "i2", name: "Daycare", amountCents: 1 }])).toBeNull();
    // Two items with the same name: ambiguous, no match.
    expect(
      matchExistingItem(rent, [
        { ...base, id: "i1", name: "Oakwood Apartments rent", amountCents: 1 },
        { ...base, id: "i3", name: "Oakwood Apartments", amountCents: 1 },
      ]),
    ).toBeNull();
  });
});

describe("candidate fields", () => {
  it("writes every key, null for what a CSV cannot know, and never a provider domain", () => {
    const c = find(detectAll(), "b-rent") as RecurringCandidate;
    const f = candidateFields(c);
    expect(Object.keys(f).sort()).toEqual([
      "accountLast4",
      "amountDueCents",
      "autoRenews",
      "cancelByDate",
      "category",
      "decisionByDate",
      "docType",
      "dueDate",
      "frequency",
      "insuranceType",
      "previousAmountCents",
      "providerDomain",
      "providerName",
      "renewalDate",
    ]);
    expect(f.providerDomain).toBeNull();
    expect(f.frequency).toBe("monthly");
    expect(f.category).toBe("housing");
    expect(f.dueDate).toBe(c.nextExpected);
  });
});

describe("decoding and header suggestions", () => {
  it("reads UTF-8 with a BOM, UTF-16 and Windows-1252", () => {
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]))).toBe("a,b");
    expect(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]))).toBe("a,b");
    expect(decodeCsvBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });

  it("suggests columns for common headers and nothing for unknown ones", () => {
    expect(suggestMapping(["Date", "Description", "Amount", "Running Bal."])).toMatchObject({
      date: "Date",
      description: "Description",
      amount: "Amount",
      balance: "Running Bal.",
    });
    expect(suggestMapping(["colA", "colB"])).toEqual({ amountSign: "outflow_negative" });
  });
});
