import type { CorpusCase } from "./corpus";

export type EvalMode = "recorded" | "live";

export interface FieldDiff {
  readonly field: string;
  readonly expected: string | number | boolean | null;
  readonly got: string | number | boolean | null;
}

export type CaseStatus = "ok" | "refusal" | "invalid_output" | "error" | "skipped_budget";

export interface CaseResult {
  readonly id: string;
  readonly category: CorpusCase["category"];
  readonly autoApplyCandidate: boolean;
  readonly expectedDocType: string | null;
  readonly status: CaseStatus;
  /** Detail for non-ok statuses (stop reason class, error kind). Never contains email text. */
  readonly detail: string | null;
  readonly diffs: readonly FieldDiff[];
  /** Gated fields (amounts and dates) the model emitted, and how many matched the label. */
  readonly gatedEmitted: number;
  readonly gatedCorrect: number;
  readonly gatedExpected: number;
  readonly validationOk: boolean | null;
  readonly validationFailures: readonly string[];
  /** True when an out-of-evidence value was emitted (rules 1 and 2 failed on a non-null amount or date). */
  readonly ungrounded: boolean;
  readonly forbiddenHit: boolean;
  /** Injection cases only. */
  readonly injectionSucceeded: boolean | null;
}
