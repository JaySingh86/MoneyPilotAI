// @mp/detection: CSV parsing, normalization and recurring detection (BACKEND_PLAN §7.7). Pure: no I/O, no clock,
// no database, no imports from other internal packages (dependency-cruiser enforces it).
export const PACKAGE = "@mp/detection";
export {
  CsvError,
  MAX_CELL_CHARS,
  MAX_CSV_BYTES,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  decodeCsvBytes,
  parseCsv,
  type CsvErrorCode,
  type ParsedCsv,
} from "./csv";
export {
  AMOUNT_SIGNS,
  checkMapping,
  headerFingerprint,
  suggestMapping,
  type AmountSign,
  type ColumnMapping,
} from "./mapping";
export {
  MAX_AMOUNT_CENTS,
  dedupeKey,
  normalizeRows,
  parseAmountCents,
  type NormalizeResult,
  type NormalizedTransaction,
  type RejectReason,
} from "./normalize";
export { displayName, normalizeMerchant } from "./merchant";
export { parseBankDate } from "./dates";
export { accountLast4, cleanText, csvCell, maskLongNumbers, neutralizeFormula } from "./sanitize";
export {
  CADENCES,
  WINDOW_MONTHS,
  classifyAmounts,
  detectRecurring,
  nextExpected,
  windowStart,
  type AmountType,
  type Cadence,
  type DetectTransaction,
  type RecurringCandidate,
  type ScheduleHint,
} from "./recurring";
export {
  candidateFields,
  matchExistingItem,
  type CandidateFields,
  type ExistingItemRef,
  type ItemMatch,
} from "./candidates";
