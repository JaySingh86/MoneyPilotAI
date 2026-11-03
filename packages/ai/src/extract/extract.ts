import type { Temporal } from "@js-temporal/polyfill";
import type { AiClient, Completion } from "../client";
import { ROUTES } from "../config";
import { loadPrompt } from "../prompts";
import type { TokenUsage } from "../pricing";
import { extractionJsonSchema, extractionSchema } from "../schemas/extraction.v1";
import type { ExtractionResult } from "../schemas/extraction.v1";
import type { ModelRequest, ModelResponse } from "../transport";
import { validateExtraction } from "./validate";
import type { ValidationResult } from "./validate";

// Extraction route (BACKEND_PLAN §7.8.2, §7.9). One call, no tools, output is the schema only.

export interface ExtractInput {
  /** Redacted email text (packages/email redacts before this call). Never raw email. */
  readonly text: string;
  /** Household-local date the email was received. */
  readonly receivedAt: Temporal.PlainDate;
  /** True when the 20k-character cap cut the text. A truncated email can never auto-apply (rule 6). */
  readonly truncated: boolean;
  readonly householdId?: string | null;
}

export type ExtractOutcome =
  | {
      readonly status: "ok";
      readonly extraction: ExtractionResult;
      /** Deterministic rule checks (BACKEND_PLAN §7.8.2). `ok: false` means: send to review, never auto-apply. */
      readonly validation: ValidationResult;
      /**
       * Signals for the auto-apply policy (BACKEND_PLAN §7.8.2 `injection_suspected`). The pipeline combines these
       * with its own checks; this package only reports what it saw.
       */
      readonly signals: { readonly fenceTampered: boolean };
      readonly usage: TokenUsage;
    }
  | { readonly status: "refusal"; readonly category: string | null; readonly usage: TokenUsage }
  | { readonly status: "invalid_output"; readonly reason: string; readonly usage: TokenUsage };

/** The 20k-character cap from BACKEND_PLAN §7.8.2 `email.fetch`. */
export const MAX_EMAIL_CHARS = 20_000;

export type ExtractInputErrorCode = "too_long" | "unredacted";

/** Thrown before any model call when the input breaks the pipeline contract. Carries no email content. */
export class ExtractInputError extends Error {
  readonly code: ExtractInputErrorCode;
  constructor(code: ExtractInputErrorCode) {
    super(
      code === "too_long"
        ? "Email text is over the 20k cap; cut it and set truncated before extraction."
        : "Email text looks unredacted (SSN shape or a run of 9+ digits); redaction must run first.",
    );
    this.name = "ExtractInputError";
    this.code = code;
  }
}

// Redaction runs first (BACKEND_PLAN §7.8.2). This is a tripwire for a pipeline bug, not a redactor: it fails
// loudly instead of sending raw identifiers to the model.
const SSN_SHAPE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
const LONG_DIGIT_RUN = /\d{9,}/;

/** Applies the input contract. Text at the cap counts as cut, whatever the caller said. */
export function prepareInput<T extends Pick<ExtractInput, "text" | "truncated">>(input: T): T {
  if (input.text.length > MAX_EMAIL_CHARS) throw new ExtractInputError("too_long");
  if (SSN_SHAPE.test(input.text) || LONG_DIGIT_RUN.test(input.text))
    throw new ExtractInputError("unredacted");
  return { ...input, truncated: input.truncated || input.text.length >= MAX_EMAIL_CHARS };
}

/**
 * Stops email text from opening or closing the `<email>` block that fences it: `<email ...>`, `</email ...>`
 * in any case, with whitespace inside, and the fullwidth look-alikes. The leading bracket becomes `&lt;`. The
 * result is also what validation uses as the source text, so quotes the model copies still match verbatim.
 */
export function neutralizeEmailDelimiters(text: string): string {
  return text.replace(/[<＜]\s*\/?\s*email\b[^>＞]*[>＞]/gi, (tag) => `&lt;${tag.slice(1)}`);
}

/** The user turn. Email content is the last thing in it, fenced and labelled as data. */
export function buildExtractUserTurn(input: Pick<ExtractInput, "text" | "receivedAt" | "truncated">): string {
  return [
    `Received: ${input.receivedAt.toString()}`,
    `Truncated: ${input.truncated ? "yes" : "no"}`,
    "<email>",
    neutralizeEmailDelimiters(input.text),
    "</email>",
  ].join("\n");
}

export function buildExtractRequest(
  rawInput: Pick<ExtractInput, "text" | "receivedAt" | "truncated">,
): ModelRequest {
  const input = prepareInput(rawInput);
  const route = ROUTES.extract;
  const prompt = loadPrompt("extract", route.promptVersion);
  return {
    model: route.model,
    effort: route.effort,
    maxTokens: route.maxTokens,
    system: prompt.text,
    user: buildExtractUserTurn(input),
    jsonSchema: extractionJsonSchema(),
  };
}

export const EXTRACT_PROMPT_ID = `extract.v${ROUTES.extract.promptVersion}`;

/** Zod-strict parse of the model's JSON. Throws on any extra key, wrong type or non-JSON text. */
export function parseExtraction(text: string): ExtractionResult {
  return extractionSchema.parse(JSON.parse(text));
}

/** Parses and validates one response. Shared by the single-call path, the batch path and the eval runner. */
export function finishExtraction(
  completion: Completion<ExtractionResult>,
  rawInput: Pick<ExtractInput, "text" | "receivedAt" | "truncated">,
): ExtractOutcome {
  const input = prepareInput(rawInput);
  if (completion.status === "refusal") return completion;
  if (completion.status === "invalid_output") {
    return { status: "invalid_output", reason: completion.reason, usage: completion.usage };
  }
  const validation = validateExtraction(completion.value, {
    sourceText: neutralizeEmailDelimiters(input.text),
    receivedAt: input.receivedAt,
    truncated: input.truncated,
  });
  return {
    status: "ok",
    extraction: completion.value,
    validation,
    signals: { fenceTampered: neutralizeEmailDelimiters(input.text) !== input.text },
    usage: completion.usage,
  };
}

export async function extractEmail(client: AiClient, input: ExtractInput): Promise<ExtractOutcome> {
  const completion = await client.complete<ExtractionResult>({
    purpose: "extract",
    promptVersion: EXTRACT_PROMPT_ID,
    request: buildExtractRequest(input),
    householdId: input.householdId ?? null,
    parse: parseExtraction,
  });
  return finishExtraction(completion, input);
}

// ---------------------------------------------------------------------------------------------------------
// Batch API helpers (backfill on connect: 13 months of mail, 50% price, results keyed by custom_id).

export interface BatchItem extends ExtractInput {
  /** Provider message id. Becomes the batch `custom_id`, so it must be 1-64 chars of [A-Za-z0-9_-]. */
  readonly messageId: string;
}

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function submitExtractionBatch(
  client: AiClient,
  items: readonly BatchItem[],
): Promise<{ id: string }> {
  if (items.length === 0) throw new Error("submitExtractionBatch: no items");
  const seen = new Set<string>();
  for (const item of items) {
    prepareInput(item); // same input contract as the single-call path, checked before anything is sent
    if (!CUSTOM_ID.test(item.messageId))
      throw new Error("submitExtractionBatch: messageId is not a valid custom_id");
    if (seen.has(item.messageId)) throw new Error("submitExtractionBatch: duplicate messageId");
    seen.add(item.messageId);
  }
  return client.createBatch(
    items.map((item) => ({ customId: item.messageId, request: buildExtractRequest(item) })),
  );
}

export interface WaitOptions {
  readonly pollMs?: number;
  readonly maxPolls?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Polls until the batch has ended. Throws if it has not ended after `maxPolls` polls. */
export async function waitForBatch(
  client: AiClient,
  batchId: string,
  options: WaitOptions = {},
): Promise<void> {
  const {
    pollMs = 30_000,
    maxPolls = 2_880,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = options;
  for (let poll = 0; poll < maxPolls; poll++) {
    if ((await client.batchStatus(batchId)) === "ended") return;
    await sleep(pollMs);
  }
  throw new Error("waitForBatch: batch did not end within the polling budget");
}

export type BatchItemOutcome = ExtractOutcome | { readonly status: "batch_error"; readonly detail: string };

/**
 * Reads results (in any order) and returns them keyed by message id. Items missing from the results are errors.
 *
 * A `refusal` outcome here is not rescued: the Batches API has no `fallbacks` (Q-076, owner answer b). The
 * caller (WP-22) re-runs every refused item through `extractEmail`, which does use the fallback chain.
 */
export async function collectExtractionBatch(
  client: AiClient,
  batchId: string,
  items: readonly BatchItem[],
  options: { readonly householdId?: string | null } = {},
): Promise<Map<string, BatchItemOutcome>> {
  const byId = new Map(items.map((item) => [item.messageId, item]));
  const results = new Map<string, BatchItemOutcome>();
  const prompt = EXTRACT_PROMPT_ID;
  for (const outcome of await client.batchResults(batchId)) {
    const item = byId.get(outcome.customId);
    if (!item) continue; // not ours; ignore rather than trust an unknown id
    if (outcome.kind !== "succeeded") {
      results.set(outcome.customId, { status: "batch_error", detail: outcome.kind });
      continue;
    }
    const response: ModelResponse = outcome.response;
    const completion = client.interpret<ExtractionResult>(response, parseExtraction);
    const finished = finishExtraction(completion, item);
    results.set(outcome.customId, finished);
    await client.meter(
      {
        purpose: "extract",
        promptVersion: prompt,
        request: buildExtractRequest(item),
        householdId: options.householdId ?? item.householdId ?? null,
      },
      response,
      completion.status,
      client.clock(),
      true,
    );
  }
  for (const id of byId.keys()) {
    if (!results.has(id)) results.set(id, { status: "batch_error", detail: "missing" });
  }
  return results;
}
