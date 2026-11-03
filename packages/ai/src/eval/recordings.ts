import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionResult } from "../schemas/extraction.v1";
import type { ModelRequest, ModelResponse, ModelTransport } from "../transport";
import { EXTRACT_PROMPT_ID, buildExtractRequest } from "../extract/extract";
import { loadPrompt } from "../prompts";
import { ROUTES } from "../config";
import { Temporal } from "@js-temporal/polyfill";
import type { Corpus, CorpusCase } from "./corpus";
import { DEFAULT_FAKE_USAGE } from "../testing/fake-transport";

// Recorded responses for offline evals. A recording is keyed by a hash of the exact request (system prompt,
// user turn, schema), so changing the prompt or schema invalidates it and forces a new eval run.

const responseSchema = z.strictObject({
  stopReason: z.string().nullable(),
  stopCategory: z.string().nullable(),
  text: z.string(),
  usage: z.strictObject({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
  model: z.string(),
});

export const recordingFileSchema = z.strictObject({
  version: z.literal(1),
  /**
   * `synthetic-oracle`: answers derived from the corpus labels. It proves the harness works and says nothing
   * about model quality. `live`: real model output captured with `--live --record`.
   */
  kind: z.enum(["synthetic-oracle", "live"]),
  promptId: z.string(),
  promptSha256: z.string(),
  model: z.string(),
  note: z.string(),
  responses: z.record(z.string(), responseSchema),
});

export type RecordingFile = z.infer<typeof recordingFileSchema>;

export function requestKey(request: ModelRequest): string {
  return createHash("sha256")
    .update(request.system)
    .update("\0")
    .update(request.user)
    .update("\0")
    .update(JSON.stringify(request.jsonSchema ?? null))
    .digest("hex")
    .slice(0, 32);
}

export class RecordingMissingError extends Error {
  constructor() {
    super(
      "No recorded response for this request. The prompt, schema or corpus changed: re-record with --live --record.",
    );
    this.name = "RecordingMissingError";
  }
}

export function createReplayTransport(file: RecordingFile): ModelTransport {
  const unsupported = (): never => {
    throw new Error("Replay transport does not support batches");
  };
  return {
    async send(request) {
      const hit = file.responses[requestKey(request)];
      if (!hit) throw new RecordingMissingError();
      return hit;
    },
    createBatch: unsupported,
    getBatchStatus: unsupported,
    getBatchResults: unsupported,
  };
}

/** Wraps a transport and captures every response for a later replay. */
export function createRecordingTransport(
  inner: ModelTransport,
  sink: Record<string, ModelResponse>,
): ModelTransport {
  return {
    async send(request) {
      const response = await inner.send(request);
      sink[requestKey(request)] = response;
      return response;
    },
    createBatch: (entries) => inner.createBatch(entries),
    getBatchStatus: (id) => inner.getBatchStatus(id),
    getBatchResults: (id) => inner.getBatchResults(id),
  };
}

function oracleExtraction(testCase: CorpusCase): ExtractionResult {
  const e = testCase.expected_fields;
  return {
    doc_type: e.doc_type ?? "irrelevant",
    provider_name: e.provider_name ?? null,
    category: e.category ?? null,
    insurance_type: e.insurance_type ?? null,
    amount_due_cents: e.amount_due_cents ?? null,
    previous_amount_cents: e.previous_amount_cents ?? null,
    due_date: e.due_date ?? null,
    renewal_date: e.renewal_date ?? null,
    cancel_by_date: e.cancel_by_date ?? null,
    decision_by_date: e.decision_by_date ?? null,
    frequency: e.frequency ?? null,
    auto_renews: e.auto_renews ?? null,
    account_last4: e.account_last4 ?? null,
    evidence: testCase.expected_evidence,
  };
}

/** The request the extraction route builds for a corpus case; recordings are keyed by it. */
export function requestForCase(testCase: CorpusCase): ModelRequest {
  return buildExtractRequest({
    text: testCase.email_text,
    receivedAt: Temporal.PlainDate.from(testCase.received_at),
    truncated: testCase.truncated,
  });
}

export function buildOracleRecording(corpus: Corpus): RecordingFile {
  const prompt = loadPrompt("extract", ROUTES.extract.promptVersion);
  const responses: Record<string, ModelResponse> = {};
  for (const testCase of corpus.cases) {
    responses[requestKey(requestForCase(testCase))] = {
      stopReason: "end_turn",
      stopCategory: null,
      text: JSON.stringify(oracleExtraction(testCase)),
      usage: DEFAULT_FAKE_USAGE,
      model: ROUTES.extract.model,
    };
  }
  return {
    version: 1,
    kind: "synthetic-oracle",
    promptId: EXTRACT_PROMPT_ID,
    promptSha256: prompt.sha256,
    model: ROUTES.extract.model,
    note:
      "SYNTHETIC ORACLE. Every answer is built from the corpus labels, so a pass proves the harness and gates " +
      "work and says nothing about model quality. Token counts are placeholders. Replace with real output via " +
      "`pnpm ai:eval -- --live --record` (needs ANTHROPIC_API_KEY).",
    responses,
  };
}
