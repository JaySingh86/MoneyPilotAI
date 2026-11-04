// Header fingerprint and column mapping (BACKEND_PLAN §7.7 step 2): a known fingerprint reuses its saved mapping,
// an unknown one needs the person to say which column is the date, the description and the amount.

export const AMOUNT_SIGNS = ["outflow_negative", "outflow_positive"] as const;
export type AmountSign = (typeof AMOUNT_SIGNS)[number];

/** Column names refer to headers of the file. Either `amount`, or `debit` and/or `credit`, is required. */
export interface ColumnMapping {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  balance?: string;
  account?: string;
  /** For a single amount column: which sign means money going out. Debit/credit columns ignore it. */
  amountSign: AmountSign;
}

/** The header row, normalized: lowercase, single spaces. Two files with the same columns share a mapping. */
export function headerFingerprint(headers: readonly string[]): string {
  return headers
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|")
    .slice(0, 2000);
}

/** Returns a problem description (no cell values) or null when the mapping fits these headers. */
export function checkMapping(mapping: ColumnMapping, headers: readonly string[]): string | null {
  const known = new Set(headers);
  const used: [string, string | undefined][] = [
    ["date", mapping.date],
    ["description", mapping.description],
    ["amount", mapping.amount],
    ["debit", mapping.debit],
    ["credit", mapping.credit],
    ["balance", mapping.balance],
    ["account", mapping.account],
  ];
  for (const [role, column] of used) {
    if (column !== undefined && !known.has(column)) return `The ${role} column is not in the file.`;
  }
  if (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined) {
    return "Choose the amount column, or the debit and credit columns.";
  }
  if (mapping.amount !== undefined && (mapping.debit !== undefined || mapping.credit !== undefined)) {
    return "Choose either one amount column or debit and credit columns, not both.";
  }
  return null;
}

const ALIASES = {
  date: ["date", "posted", "posted date", "posting date", "transaction date", "post date", "trans date"],
  description: ["description", "details", "payee", "memo", "name", "merchant", "transaction description"],
  amount: ["amount", "transaction amount"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "money out"],
  credit: ["credit", "credits", "deposit", "deposits", "money in"],
  balance: ["balance", "running balance", "running bal.", "running bal"],
  account: ["account", "account number", "account #", "card"],
} as const;

/** A starting point for the mapping screen only. It is never applied without a person confirming it. */
export function suggestMapping(headers: readonly string[]): Partial<ColumnMapping> {
  const find = (names: readonly string[]) =>
    headers.find((h) => names.includes(h.trim().toLowerCase().replace(/\s+/g, " ")));
  const out: Partial<ColumnMapping> = {};
  const date = find(ALIASES.date);
  const description = find(ALIASES.description);
  const amount = find(ALIASES.amount);
  const debit = find(ALIASES.debit);
  const credit = find(ALIASES.credit);
  const balance = find(ALIASES.balance);
  const account = find(ALIASES.account);
  if (date) out.date = date;
  if (description) out.description = description;
  if (amount) out.amount = amount;
  else {
    if (debit) out.debit = debit;
    if (credit) out.credit = credit;
  }
  if (balance) out.balance = balance;
  if (account) out.account = account;
  out.amountSign = "outflow_negative";
  return out;
}
