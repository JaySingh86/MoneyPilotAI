import { describe, expect, it } from "vitest";
import {
  CsvError,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  accountLast4,
  checkMapping,
  classifyAmounts,
  cleanText,
  csvCell,
  decodeCsvBytes,
  detectRecurring,
  headerFingerprint,
  maskLongNumbers,
  neutralizeFormula,
  normalizeMerchant,
  normalizeRows,
  parseAmountCents,
  parseBankDate,
  parseCsv,
  type ColumnMapping,
} from "./index";

describe("parseAmountCents", () => {
  it.each([
    ["12.34", 1234],
    ["$1,234.50", 123450],
    ["-12", -1200],
    ["(12.00)", -1200],
    ["12.00-", -1200],
    ["+3.5", 350],
    [".5", 50],
    ["0", 0],
  ])("%s", (text, cents) => expect(parseAmountCents(text)).toBe(cents));
  it.each(["", "abc", "1.234", "1e5", "1,2,3x", "99999999999999.00", "--5", "$"])("rejects %j", (text) =>
    expect(parseAmountCents(text)).toBeNull(),
  );
});

describe("parseBankDate", () => {
  it.each([
    ["10/27/2026", "2026-10-27"],
    ["1/5/26", "2026-01-05"],
    ["2026-10-27", "2026-10-27"],
    ["2026/10/27", "2026-10-27"],
    ["27/10/2026", "2026-10-27"],
    ["Oct 27, 2026", "2026-10-27"],
    ["12-31-2025", "2025-12-31"],
  ])("%s", (text, iso) => expect(parseBankDate(text)).toBe(iso));
  it.each(["", "13/13/2026", "02/30/2026", "tomorrow", "Foo 3, 2026"])("rejects %j", (text) =>
    expect(parseBankDate(text)).toBeNull(),
  );
  it("tries MM/DD first: 03/04/2026 is March 4", () =>
    expect(parseBankDate("03/04/2026")).toBe("2026-03-04"));
});

describe("normalizeMerchant", () => {
  it("strips store numbers, reference ids, dates and processor words", () => {
    expect(normalizeMerchant("ACH DEBIT RIVERBEND WATER & TRASH REF 884213 10/18")).toBe(
      "riverbend water trash",
    );
    expect(normalizeMerchant("POS PURCHASE FRESH MARKET #1234 09/03")).toBe("fresh market");
    expect(normalizeMerchant("SQ *CORNER CAFE 55512")).toBe("corner cafe");
  });
  it("maps aliases and never returns an empty name", () => {
    expect(normalizeMerchant("NETFLIX.COM 866-579-7172")).toBe("netflix");
    expect(normalizeMerchant("AMZN MKTP US*2K4XY")).toBe("amazon");
    expect(normalizeMerchant("12345 6789")).toBe("unknown");
  });
  it("only ever contains letters, digits and spaces", () => {
    expect(normalizeMerchant('=HYPERLINK("http://x","y") ; DROP TABLE')).toMatch(/^[a-z0-9 ]+$/);
  });
});

describe("sanitizing imported text", () => {
  it.each(["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tTAB", "\rCR"])("neutralizes a leading %j", (cell) => {
    expect(neutralizeFormula(cell).startsWith("'")).toBe(true);
    expect(cleanText(cell).startsWith("'") || !/^[=+\-@\t\r]/.test(cleanText(cell))).toBe(true);
    expect(csvCell(cell).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  it("leaves ordinary text alone and quotes cells that need it", () => {
    expect(neutralizeFormula("Rent")).toBe("Rent");
    expect(csvCell('Say "hi", ok')).toBe('"Say ""hi"", ok"');
  });
  it("cleanText removes control characters, masks long numbers and caps the length", () => {
    expect(cleanText("PAY\u0000 ACCT 1234 5678 9012 3456")).toBe("PAY ACCT ****3456");
    expect(cleanText("x".repeat(500))).toHaveLength(200);
  });
  it("keeps short numbers and dates", () => {
    expect(maskLongNumbers("ref 12345678 on 10/18/2026")).toBe("ref 12345678 on 10/18/2026");
    expect(maskLongNumbers("acct 123456789")).toBe("acct ****6789");
  });
  it("accountLast4 never returns more than 4 digits", () => {
    expect(accountLast4("XXXX-XXXX-4821")).toBe("4821");
    expect(accountLast4("1234567890123456")).toBe("3456");
    expect(accountLast4("Checking")).toBeNull();
  });
  it("a formula in an imported description is neutral in the stored description", () => {
    const m: ColumnMapping = { date: "d", description: "t", amount: "a", amountSign: "outflow_negative" };
    const out = normalizeRows([{ d: "10/01/2026", t: '=HYPERLINK("http://evil")', a: "-5.00" }], m);
    expect(out.transactions[0]?.description.startsWith("'=")).toBe(true);
    expect(out.transactions[0]?.merchantNorm).toMatch(/^[a-z0-9 ]+$/);
  });
});

describe("parseCsv", () => {
  it("detects the delimiter and keeps quoted commas", () => {
    const a = parseCsv('Date;Desc;Amt\n10/01/2026;"A, B";5.00\n');
    expect(a.delimiter).toBe(";");
    expect(a.rows[0]).toEqual({ Date: "10/01/2026", Desc: "A, B", Amt: "5.00" });
    expect(parseCsv("a\tb\n1\t2\n").delimiter).toBe("\t");
  });
  it("names empty and repeated headers", () => {
    expect(parseCsv("a,,a\n1,2,3\n").headers).toEqual(["a", "column 2", "a (2)"]);
  });
  it("enforces the limits with typed errors", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof CsvError ? e.code : "other";
      }
      return "none";
    };
    expect(code(() => parseCsv(""))).toBe("empty");
    expect(code(() => parseCsv("a,b\n"))).toBe("no_rows");
    expect(
      code(() => parseCsv(`${Array.from({ length: MAX_CSV_COLUMNS + 1 }, (_, i) => `c${i}`).join(",")}\n1`)),
    ).toBe("too_many_columns");
    expect(code(() => parseCsv(`a\n${"1\n".repeat(MAX_CSV_ROWS + 1)}`))).toBe("too_many_rows");
    expect(code(() => decodeCsvBytes(new Uint8Array(0)))).toBe("empty");
    expect(code(() => decodeCsvBytes(new Uint8Array(10 * 1024 * 1024 + 1)))).toBe("too_large");
  });
  it("caps a cell at 2000 characters", () => {
    expect(parseCsv(`a\n${"x".repeat(5000)}\n`).rows[0]?.a).toHaveLength(2000);
  });
});

describe("mapping", () => {
  it("fingerprints headers regardless of case and spacing", () => {
    expect(headerFingerprint(["Date ", "DESCRIPTION", "Running  Bal."])).toBe(
      "date|description|running bal.",
    );
  });
  it("checks that mapped columns exist and the amount is chosen once", () => {
    const base: ColumnMapping = { date: "d", description: "t", amount: "a", amountSign: "outflow_negative" };
    expect(checkMapping(base, ["d", "t", "a"])).toBeNull();
    expect(checkMapping({ ...base, date: "zzz" }, ["d", "t", "a"])).toMatch(/date column/);
    expect(checkMapping({ date: "d", description: "t", amountSign: "outflow_negative" }, ["d", "t"])).toMatch(
      /amount/,
    );
    expect(checkMapping({ ...base, debit: "a" }, ["d", "t", "a"])).toMatch(/either/);
  });
  it("outflow_positive flips the sign of a single amount column (credit card exports)", () => {
    const m: ColumnMapping = { date: "d", description: "t", amount: "a", amountSign: "outflow_positive" };
    expect(normalizeRows([{ d: "10/01/2026", t: "Shop", a: "5.00" }], m).transactions[0]?.amountCents).toBe(
      -500,
    );
  });
  it("counts rows it cannot read instead of failing", () => {
    const m: ColumnMapping = { date: "d", description: "t", amount: "a", amountSign: "outflow_negative" };
    const r = normalizeRows(
      [
        { d: "bad", t: "x", a: "1" },
        { d: "10/01/2026", t: "x", a: "zz" },
        { d: "10/01/2026", t: "  ", a: "1" },
        { d: "10/01/2026", t: "x", a: "1" },
      ],
      m,
    );
    expect(r.rejectedBy).toEqual({ date: 1, amount: 1, description: 1 });
    expect(r.transactions).toHaveLength(1);
  });
  it("numbers identical rows on one day so a re-import hashes the same", () => {
    const m: ColumnMapping = { date: "d", description: "t", amount: "a", amountSign: "outflow_negative" };
    const r = normalizeRows(
      Array.from({ length: 3 }, () => ({ d: "10/01/2026", t: "Coffee", a: "-3.00" })),
      m,
    );
    expect(r.transactions.map((t) => t.occurrence)).toEqual([0, 1, 2]);
  });
});

describe("classifyAmounts", () => {
  it("is fixed under 10% variation and estimated above, in exact integers", () => {
    expect(classifyAmounts([10000, 10000, 10000])).toBe("fixed");
    expect(classifyAmounts([10000, 10500, 9500])).toBe("fixed");
    expect(classifyAmounts([11800, 17100, 13700])).toBe("estimated");
    expect(classifyAmounts([100, 100, 100, 100, 100, 100, 100, 100, 100, 5_000_000_000])).toBe("estimated");
  });
});

describe("detectRecurring edge cases", () => {
  const tx = (postedOn: string, merchantNorm: string, amountCents: number) => ({
    postedOn,
    merchantNorm,
    amountCents,
    description: merchantNorm,
  });
  it("ignores a subscription that stopped long ago and one outside the 13 months", () => {
    const old = ["2025-01-05", "2025-02-05", "2025-03-05"].map((d) => tx(d, "gym", -1000));
    expect(detectRecurring(old, "2026-10-27")).toEqual([]);
    const stopped = ["2026-03-05", "2026-04-05", "2026-05-05"].map((d) => tx(d, "gym", -1000));
    expect(detectRecurring(stopped, "2026-10-27")).toEqual([]);
  });
  it("needs three hits for monthly but only two (a year apart) for yearly", () => {
    expect(
      detectRecurring([tx("2026-08-05", "x", -1000), tx("2026-09-05", "x", -1000)], "2026-10-27"),
    ).toEqual([]);
    const yearly = detectRecurring(
      [tx("2025-10-10", "domain renewal", -1500), tx("2026-10-10", "domain renewal", -1500)],
      "2026-10-27",
    );
    expect(yearly[0]).toMatchObject({ cadence: "yearly", nextExpected: "2027-10-10" });
  });
  it("finds weekly and every-2-months cadences", () => {
    const w = [
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
      "2026-10-06",
      "2026-10-13",
    ].map((d) => tx(d, "market box", -2500));
    expect(detectRecurring(w, "2026-10-27")[0]?.cadence).toBe("weekly");
    const bi = ["2026-02-10", "2026-04-10", "2026-06-10", "2026-08-10", "2026-10-10"].map((d) =>
      tx(d, "septic", -9000),
    );
    expect(detectRecurring(bi, "2026-10-27")[0]?.cadence).toBe("every_2_months");
  });
  it("a merchant visited at random is not a bill", () => {
    const days = [
      "2026-06-02",
      "2026-06-05",
      "2026-06-23",
      "2026-07-01",
      "2026-07-30",
      "2026-08-02",
      "2026-09-14",
    ];
    expect(
      detectRecurring(
        days.map((d) => tx(d, "cafe", -450)),
        "2026-10-27",
      ),
    ).toEqual([]);
  });
  it("collapses two charges on one day and skips zero amounts", () => {
    const rows = ["2026-08-05", "2026-09-05", "2026-10-05"].flatMap((d) => [
      tx(d, "split", -500),
      tx(d, "split", -500),
      tx(d, "zero", 0),
    ]);
    const [c] = detectRecurring(rows, "2026-10-27");
    expect(c).toMatchObject({ merchantNorm: "split", amountCents: 1000, occurrences: 3 });
  });
  it("lists an inflow separately from an outflow of the same merchant", () => {
    const rows = ["2026-08-05", "2026-09-05", "2026-10-05"].flatMap((d) => [
      tx(d, "co", -500),
      tx(d, "co", 700),
    ]);
    expect(detectRecurring(rows, "2026-10-27").map((c) => c.key)).toEqual(["inflow:co", "outflow:co"]);
  });
});
