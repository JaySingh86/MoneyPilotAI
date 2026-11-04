// Synthetic 13-month bank exports for the Rivera fixture household (WP-16 acceptance). Deterministic: the same
// fixture and `asOf` always produce the same bytes. All names, merchants and numbers are fictional.
//
// Two files, in two different bank layouts, so mapping is exercised both ways:
//   sam      "Date,Description,Amount,Running Bal." MM/DD/YYYY, one signed amount, a running balance column
//   jordan   "Posted;Payee;Withdrawals;Deposits;Account" YYYY-MM-DD, semicolons, separate debit and credit columns
// Each bill goes to its owner's file. Bills post on their due day, or the next weekday when that is a weekend.
// Random one-off purchases are mixed in, so detection has noise to ignore.
import { Temporal } from "@js-temporal/polyfill";

interface FixtureBill {
  id: string;
  owner: string;
  name: string;
  amountCents?: number;
  previousAmountCents?: number;
  priceChangedOn?: string;
  estimate?: { historyCents?: number[]; fromLastStatementCents?: number };
  schedule: { type: string; day?: number | "last"; n?: number; next?: string };
}
interface FixtureIncome {
  id: string;
  owner: string;
  amountCents: number;
  schedule: { type: string; anchor?: string; weekday?: string };
}
export interface RiveraFixtureSlice {
  bills: FixtureBill[];
  incomes: FixtureIncome[];
  balance: { amountCents: number };
  members: { id: string }[];
}

/** Fictional bank descriptions, one per fixture bill / income id. The tests find candidates through these. */
export const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "b-car": "NORTHSTAR AUTO FINANCE PMT",
  "b-phone": "BLUEJAY WIRELESS",
  "b-rent": "OAKWOOD APARTMENTS RENT",
  "b-daycare": "LITTLE SPROUTS DAYCARE",
  "b-stream": "STREAMLY BUNDLE",
  "b-power": "CITY POWER AND LIGHT",
  "b-carins": "HARBOR MUTUAL AUTO INS",
  "b-internet": "FIBERLINK INTERNET",
  "b-news": "DAILY LEDGER NEWS",
  "b-cloud": "CLOUDLOCKER STORAGE",
  "b-musicf": "TUNEWAVE FAMILY",
  "b-card": "SUMMIT CARD SERVICES",
  "b-fit": "FITPULSE APP",
  "b-water": "RIVERBEND WATER AND TRASH",
  "b-music2": "SONGBIRD MUSIC",
  "b-kids": "BRIGHTMIND KIDS APP",
  "inc-sam": "ACME LOGISTICS PAYROLL DIRECT DEP",
  "inc-jordan": "PELICAN HEALTH SALARY DIRECT DEP",
};

const NOISE_MERCHANTS = [
  "FRESH MARKET",
  "CORNER CAFE",
  "GAS N GO",
  "HARDWARE DEPOT",
  "PIZZA PLACE",
  "TOY BARN",
  "PHARMACY PLUS",
];

/** Small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  date: string; // ISO
  description: string;
  cents: number; // signed, outflow negative
}

const D = (iso: string) => Temporal.PlainDate.from(iso);

function nextWeekday(d: Temporal.PlainDate): Temporal.PlainDate {
  let x = d;
  while (x.dayOfWeek > 5) x = x.add({ days: 1 });
  return x;
}

function monthStarts(asOf: Temporal.PlainDate): Temporal.PlainDate[] {
  const out: Temporal.PlainDate[] = [];
  let m = asOf.with({ day: 1 }).subtract({ months: 13 });
  while (Temporal.PlainDate.compare(m, asOf) <= 0) {
    out.push(m);
    m = m.add({ months: 1 });
  }
  return out;
}

/** Seasonal series ending in the fixture's own three months of history (oldest first). */
function variableAmounts(count: number, base: number, ending: number[]): number[] {
  const pattern = [0.86, 0.9, 1.0, 1.18, 1.3, 1.22, 1.08, 0.94, 0.88, 0.92, 1.12, 1.25, 1.02];
  const head = Array.from(
    { length: count - ending.length },
    (_, i) => Math.round((base * (pattern[i % pattern.length] ?? 1)) / 100) * 100,
  );
  return [...head, ...ending];
}

function billRows(bill: FixtureBill, asOf: Temporal.PlainDate, windowStart: Temporal.PlainDate): Row[] {
  const description = DESCRIPTIONS[bill.id] ?? bill.name.toUpperCase();
  const rows: Row[] = [];
  const dates: Temporal.PlainDate[] = [];
  const s = bill.schedule;
  if (s.type === "monthly") {
    for (const m of monthStarts(asOf)) {
      const day = s.day === "last" ? m.daysInMonth : Math.min(Number(s.day), m.daysInMonth);
      const due = m.with({ day });
      dates.push(s.day === "last" ? due : nextWeekday(due));
    }
  } else if (s.type === "every_n_months" && s.next && s.n) {
    let due = D(s.next);
    while (Temporal.PlainDate.compare(due, asOf) > 0) due = due.subtract({ months: s.n });
    while (Temporal.PlainDate.compare(due, windowStart) >= 0) {
      dates.push(due);
      due = due.subtract({ months: s.n });
    }
    dates.reverse();
  }
  const inRange = dates.filter(
    (d) => Temporal.PlainDate.compare(d, asOf) <= 0 && Temporal.PlainDate.compare(d, windowStart) >= 0,
  );
  const history = bill.estimate?.historyCents;
  const variable = history
    ? variableAmounts(inRange.length, 14_000, history)
    : bill.estimate?.fromLastStatementCents
      ? variableAmounts(inRange.length, bill.estimate.fromLastStatementCents, [
          bill.estimate.fromLastStatementCents,
        ])
      : null;
  inRange.forEach((d, i) => {
    let cents = bill.amountCents ?? 0;
    if (variable) cents = variable[i] ?? cents;
    else if (bill.priceChangedOn && bill.previousAmountCents && d.toString() < bill.priceChangedOn) {
      cents = bill.previousAmountCents;
    }
    const ref = 100000 + ((i * 7919 + bill.id.length * 131) % 899999);
    rows.push({ date: d.toString(), description: `${description} REF ${ref}`, cents: -cents });
  });
  return rows;
}

function incomeRows(inc: FixtureIncome, asOf: Temporal.PlainDate, windowStart: Temporal.PlainDate): Row[] {
  const description = DESCRIPTIONS[inc.id] ?? "PAYROLL";
  const out: Row[] = [];
  if (inc.schedule.type === "biweekly" && inc.schedule.anchor) {
    let d = D(inc.schedule.anchor);
    while (Temporal.PlainDate.compare(d, asOf) > 0) d = d.subtract({ days: 14 });
    for (; Temporal.PlainDate.compare(d, windowStart) >= 0; d = d.subtract({ days: 14 })) {
      out.push({ date: d.toString(), description, cents: inc.amountCents });
    }
  } else if (inc.schedule.type === "monthly_last_weekday") {
    for (const m of monthStarts(asOf)) {
      let d = m.with({ day: m.daysInMonth });
      while (d.dayOfWeek !== 5) d = d.subtract({ days: 1 }); // Friday
      if (Temporal.PlainDate.compare(d, asOf) <= 0 && Temporal.PlainDate.compare(d, windowStart) >= 0) {
        out.push({ date: d.toString(), description, cents: inc.amountCents });
      }
    }
  }
  return out;
}

function noiseRows(asOf: Temporal.PlainDate, windowStart: Temporal.PlainDate, seed: number): Row[] {
  const next = rng(seed);
  const out: Row[] = [];
  let d = windowStart;
  while (Temporal.PlainDate.compare(d, asOf) <= 0) {
    d = d.add({ days: 1 + Math.floor(next() * 5) });
    if (Temporal.PlainDate.compare(d, asOf) > 0) break;
    const merchant = NOISE_MERCHANTS[Math.floor(next() * NOISE_MERCHANTS.length)] ?? "CORNER CAFE";
    const cents = 800 + Math.floor(next() * 14_000);
    out.push({
      date: d.toString(),
      description: `${merchant} #${1000 + Math.floor(next() * 8999)}`,
      cents: -cents,
    });
  }
  return out;
}

const usDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};
const money = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

export interface RiveraCsvs {
  sam: string;
  jordan: string;
  asOf: string;
  /** Description base per fixture id, for finding candidates. */
  descriptions: Readonly<Record<string, string>>;
  /** The balance on `asOf` the Sam file's last row must report. */
  samBalanceCents: number;
}

export function buildRiveraCsvs(fixture: RiveraFixtureSlice, asOf: string): RiveraCsvs {
  const end = D(asOf);
  const start = end.subtract({ months: 13 }).add({ days: 1 });
  const [samId, jordanId] = [fixture.members[0]?.id ?? "m-sam", fixture.members[1]?.id ?? "m-jordan"];
  const samRows: Row[] = noiseRows(end, start, 11);
  const jordanRows: Row[] = noiseRows(end, start, 23);
  for (const b of fixture.bills) (b.owner === samId ? samRows : jordanRows).push(...billRows(b, end, start));
  for (const i of fixture.incomes)
    (i.owner === samId ? samRows : jordanRows).push(...incomeRows(i, end, start));
  void jordanId;

  const byDate = (a: Row, b: Row) =>
    a.date.localeCompare(b.date) || a.description.localeCompare(b.description);
  samRows.sort(byDate);
  jordanRows.sort(byDate);

  // Running balance for Sam's file, worked backward from the fixture balance on asOf.
  const balances: number[] = new Array<number>(samRows.length);
  let running = fixture.balance.amountCents;
  for (let i = samRows.length - 1; i >= 0; i--) {
    balances[i] = running;
    running -= samRows[i]?.cents ?? 0;
  }
  const sam = [
    "Date,Description,Amount,Running Bal.",
    ...samRows.map((r, i) =>
      [usDate(r.date), quote(r.description), money(r.cents), money(balances[i] ?? 0)].join(","),
    ),
  ].join("\r\n");
  const jordan = [
    "Posted;Payee;Withdrawals;Deposits;Account",
    ...jordanRows.map((r) =>
      [
        r.date,
        r.description,
        r.cents < 0 ? money(-r.cents) : "",
        r.cents > 0 ? money(r.cents) : "",
        "XXXX-XXXX-4821",
      ].join(";"),
    ),
  ].join("\n");
  return {
    sam,
    jordan,
    asOf,
    descriptions: DESCRIPTIONS,
    samBalanceCents: balances[samRows.length - 1] ?? fixture.balance.amountCents,
  };
}
