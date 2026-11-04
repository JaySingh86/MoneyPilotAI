// Normalize rows (BACKEND_PLAN §7.7 step 3 and 4): dates to ISO, amounts to integer cents with outflow negative,
// merchant_norm, sanitized description, last-4 account label. No floats touch money: amounts are parsed from text.
import { parseBankDate } from "./dates";
import type { ColumnMapping } from "./mapping";
import { normalizeMerchant } from "./merchant";
import { accountLast4, cleanText } from "./sanitize";

/** Largest absolute amount accepted ($1 billion), matching the `transactions` check constraint. */
export const MAX_AMOUNT_CENTS = 100_000_000_000;

/** "$1,234.50", "(12.00)", "12.00-", "-12", "+3.5" to cents; null when it is not a plain amount. */
export function parseAmountCents(text: string): number | null {
  let s = text.trim().replace(/[$\s]/g, "").replace(/,/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  const m = /^(\d+)?(?:\.(\d{1,2}))?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const whole = m[1] ?? "0";
  if (whole.length > 12) return null;
  const cents = Number(whole) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (cents > MAX_AMOUNT_CENTS) return null;
  return negative ? -cents : cents;
}

export interface NormalizedTransaction {
  postedOn: string;
  /** Sanitized: control characters removed, long numbers masked, formulas neutralised. */
  description: string;
  merchantNorm: string;
  /** Negative = outflow. */
  amountCents: number;
  accountLast4: string | null;
  balanceCents: number | null;
  /** 0 for the first row with this date, amount and merchant in the file, 1 for the second, and so on. */
  occurrence: number;
}

export type RejectReason = "date" | "amount" | "description";

export interface NormalizeResult {
  transactions: NormalizedTransaction[];
  rejected: number;
  rejectedBy: Record<RejectReason, number>;
  /** The balance after the most recent transaction, when the file has a balance column. */
  latestBalance: { cents: number; on: string } | null;
}

function amountOf(row: Record<string, string>, m: ColumnMapping): number | null {
  if (m.amount !== undefined) {
    const v = parseAmountCents(row[m.amount] ?? "");
    if (v === null) return null;
    return m.amountSign === "outflow_negative" ? v : -v;
  }
  const debitText = m.debit === undefined ? "" : (row[m.debit] ?? "").trim();
  const creditText = m.credit === undefined ? "" : (row[m.credit] ?? "").trim();
  const debit = debitText === "" ? 0 : parseAmountCents(debitText);
  const credit = creditText === "" ? 0 : parseAmountCents(creditText);
  if (debit === null || credit === null || (debitText === "" && creditText === "")) return null;
  return Math.abs(credit) - Math.abs(debit);
}

export function normalizeRows(
  rows: readonly Record<string, string>[],
  mapping: ColumnMapping,
): NormalizeResult {
  const out: NormalizedTransaction[] = [];
  const rejectedBy: Record<RejectReason, number> = { date: 0, amount: 0, description: 0 };
  const seen = new Map<string, number>();
  for (const row of rows) {
    const postedOn = parseBankDate(row[mapping.date] ?? "");
    if (postedOn === null) {
      rejectedBy.date += 1;
      continue;
    }
    const amountCents = amountOf(row, mapping);
    if (amountCents === null) {
      rejectedBy.amount += 1;
      continue;
    }
    const rawDescription = row[mapping.description] ?? "";
    if (rawDescription.trim() === "") {
      rejectedBy.description += 1;
      continue;
    }
    const merchantNorm = normalizeMerchant(rawDescription);
    const key = `${postedOn}|${amountCents}|${merchantNorm}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const balanceText = mapping.balance === undefined ? "" : (row[mapping.balance] ?? "");
    out.push({
      postedOn,
      description: cleanText(rawDescription),
      merchantNorm,
      amountCents,
      accountLast4: mapping.account === undefined ? null : accountLast4(row[mapping.account] ?? ""),
      balanceCents: balanceText.trim() === "" ? null : parseAmountCents(balanceText),
      occurrence,
    });
  }
  return {
    transactions: out,
    rejected: rejectedBy.date + rejectedBy.amount + rejectedBy.description,
    rejectedBy,
    latestBalance: latestBalance(out),
  };
}

/** Files list newest first or oldest first; within the latest day the last row is the latest when ascending. */
function latestBalance(txs: readonly NormalizedTransaction[]): { cents: number; on: string } | null {
  const withBalance = txs.filter((t) => t.balanceCents !== null);
  const first = withBalance[0];
  const last = withBalance[withBalance.length - 1];
  if (!first || !last) return null;
  const ascending = first.postedOn <= last.postedOn;
  let best: NormalizedTransaction = first;
  for (const t of withBalance) {
    if (t.postedOn > best.postedOn || (t.postedOn === best.postedOn && ascending)) best = t;
  }
  return { cents: best.balanceCents ?? 0, on: best.postedOn };
}

/** The pieces the worker hashes with the household id (sha256 needs node:crypto, which this package avoids). */
export function dedupeKey(
  t: Pick<NormalizedTransaction, "postedOn" | "amountCents" | "merchantNorm" | "occurrence">,
): string {
  return `${t.postedOn}|${t.amountCents}|${t.merchantNorm}|${t.occurrence}`;
}
