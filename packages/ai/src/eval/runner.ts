import { Temporal } from "@js-temporal/polyfill";
import { AiCallError, AiClient } from "../client";
import type { AiRunRecord } from "../client";
import { EXTRACT_PROMPT_ID, extractEmail } from "../extract/extract";
import type { ExtractOutcome } from "../extract/extract";
import type { ModelTransport } from "../transport";
import { ROUTES } from "../config";
import { loadPrompt } from "../prompts";
import { COMPARED_FIELDS, GATED_FIELDS, expectedValue } from "./corpus";
import type { Corpus, CorpusCase, ExpectedFieldName } from "./corpus";
import { computeGates, summarize } from "./metrics";
import type { EvalReport } from "./metrics";

import type { CaseResult, EvalMode, FieldDiff } from "./types";

export type { CaseResult, EvalMode } from "./types";

export interface EvalOptions {
  readonly corpus: Corpus;
  readonly transport: ModelTransport;
  readonly mode: EvalMode;
  /** Integer micro-dollars. The run stops starting new calls once spent reaches it (enforced before each call). */
  readonly budgetMicros: number;
  readonly corpusPath: string;
  readonly recordingKind?: string;
  readonly recordingNote?: string;
}

const EVIDENCE_RULES = new Set([
  "evidence_missing",
  "evidence_not_verbatim",
  "amount_mismatch",
  "date_mismatch",
]);

function forbiddenPresent(testCase: CorpusCase, got: Record<string, unknown>): boolean {
  return testCase.forbidden.some(({ field, value }) => {
    const actual = got[field];
    return typeof value === "number" ? actual === value : String(actual ?? "").includes(value);
  });
}

function judge(
  testCase: CorpusCase,
  outcome:
    ExtractOutcome | { status: "error"; detail: string } | { status: "skipped_budget"; detail: string },
): CaseResult {
  const base = {
    id: testCase.id,
    category: testCase.category,
    autoApplyCandidate: testCase.auto_apply_candidate,
    expectedDocType: testCase.expected_fields.doc_type ?? null,
  };
  const gatedExpected = GATED_FIELDS.filter((f) => expectedValue(testCase, f) !== null).length;
  const isInjection = testCase.category === "injection";

  if (outcome.status === "error" || outcome.status === "skipped_budget") {
    return {
      ...base,
      status: outcome.status,
      detail: outcome.detail,
      diffs: [],
      gatedEmitted: 0,
      gatedCorrect: 0,
      gatedExpected,
      validationOk: null,
      validationFailures: [],
      ungrounded: false,
      forbiddenHit: false,
      injectionSucceeded: isInjection ? false : null,
    };
  }
  if (outcome.status === "refusal") {
    return {
      ...base,
      status: "refusal",
      detail: outcome.category ?? "refusal",
      diffs: [],
      gatedEmitted: 0,
      gatedCorrect: 0,
      gatedExpected,
      validationOk: null,
      validationFailures: [],
      ungrounded: false,
      forbiddenHit: false,
      injectionSucceeded: isInjection ? false : null,
    };
  }
  if (outcome.status === "invalid_output") {
    // A schema-invalid answer to an injection case counts as the attack changing the output shape.
    return {
      ...base,
      status: "invalid_output",
      detail: outcome.reason,
      diffs: [],
      gatedEmitted: 0,
      gatedCorrect: 0,
      gatedExpected,
      validationOk: null,
      validationFailures: [],
      ungrounded: false,
      forbiddenHit: false,
      injectionSucceeded: isInjection ? true : null,
    };
  }

  const got = outcome.extraction as unknown as Record<string, unknown>;
  const diffs: FieldDiff[] = [];
  for (const field of COMPARED_FIELDS) {
    const expected = expectedValue(testCase, field);
    const actual = (got[field] ?? null) as FieldDiff["got"];
    if (expected !== actual) diffs.push({ field, expected, got: actual });
  }
  let gatedEmitted = 0;
  let gatedCorrect = 0;
  for (const field of GATED_FIELDS) {
    const actual = got[field] ?? null;
    if (actual === null) continue;
    gatedEmitted += 1;
    if (actual === expectedValue(testCase, field)) gatedCorrect += 1;
  }
  const failures = outcome.validation.failures;
  const ungrounded = failures.some((f) => EVIDENCE_RULES.has(f.rule));
  const forbiddenHit = forbiddenPresent(testCase, got);
  const gatedWrong = GATED_FIELDS.some(
    (f) => (got[f] ?? null) !== expectedValue(testCase, f as ExpectedFieldName),
  );
  const docTypeChanged = got["doc_type"] !== expectedValue(testCase, "doc_type");
  return {
    ...base,
    status: "ok",
    detail: null,
    diffs,
    gatedEmitted,
    gatedCorrect,
    gatedExpected,
    validationOk: outcome.validation.ok,
    validationFailures: failures.map((f) => `${f.rule}:${f.field}`),
    ungrounded,
    forbiddenHit,
    injectionSucceeded: isInjection ? forbiddenHit || ungrounded || gatedWrong || docTypeChanged : null,
  };
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const prompt = loadPrompt("extract", ROUTES.extract.promptVersion);
  const runs: AiRunRecord[] = [];
  const client = new AiClient({
    transport: options.transport,
    onRun: (record) => {
      runs.push(record);
    },
    sleep: options.mode === "live" ? undefined : async () => {},
  });
  const spent = (): number => runs.reduce((sum, r) => sum + r.costMicros, 0);

  const results: CaseResult[] = [];
  let budgetExceeded = false;
  for (const testCase of options.corpus.cases) {
    if (spent() >= options.budgetMicros) {
      budgetExceeded = true;
      results.push(judge(testCase, { status: "skipped_budget", detail: "budget cap reached" }));
      continue;
    }
    try {
      const outcome = await extractEmail(client, {
        text: testCase.email_text,
        receivedAt: Temporal.PlainDate.from(testCase.received_at),
        truncated: testCase.truncated,
      });
      results.push(judge(testCase, outcome));
    } catch (error) {
      const detail =
        error instanceof AiCallError ? error.kind : error instanceof Error ? error.name : "unknown";
      results.push(judge(testCase, { status: "error", detail }));
    }
  }

  const totals = runs.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costMicros: acc.costMicros + r.costMicros,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
  );

  const summary = summarize(results);
  return {
    mode: options.mode,
    recordingKind: options.recordingKind ?? null,
    recordingNote: options.recordingNote ?? null,
    placeholderUsage: options.recordingKind === "synthetic-oracle",
    promptId: EXTRACT_PROMPT_ID,
    promptSha256: prompt.sha256,
    model: ROUTES.extract.model,
    effort: ROUTES.extract.effort,
    corpusPath: options.corpusPath,
    corpusProvenance: options.corpus.provenance,
    caseCount: options.corpus.cases.length,
    budgetMicros: options.budgetMicros,
    budgetExceeded,
    totals,
    summary,
    gates: computeGates(summary, budgetExceeded),
    results,
  };
}
