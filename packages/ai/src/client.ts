import Anthropic from "@anthropic-ai/sdk";
import { RETRY } from "./config";
import type { AiRoute } from "./config";
import { priceModel } from "./pricing";
import type { TokenUsage } from "./pricing";
import type { BatchOutcome, BatchStatus, ModelRequest, ModelResponse, ModelTransport } from "./transport";

export type AiPurpose = AiRoute | "eval";
export type AiRunStatus = "ok" | "refusal" | "invalid_output" | "error";

/** One row for `ai_runs` (BACKEND_PLAN §5): metadata and counts only, never prompt or output text. */
export interface AiRunRecord {
  readonly householdId: string | null;
  /** What the call was for (an email message id), so a retried batch collect can record each result once. Never content. */
  readonly reference: string | null;
  readonly purpose: AiPurpose;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly batch: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Estimate in integer micro-dollars (Q-071), never an invoice figure. */
  readonly costMicros: number;
  /** True when the response's model was not in the price table and another rate was used. */
  readonly costEstimated: boolean;
  readonly stopReason: string | null;
  readonly latencyMs: number;
  readonly status: AiRunStatus;
}

export type AiErrorKind = "rate_limited" | "server_error" | "connection" | "client_error";

/** Thrown when a call cannot succeed: retries exhausted, or a non-retryable 4xx. Carries no request content. */
export class AiCallError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | undefined;
  readonly attempts: number;
  constructor(kind: AiErrorKind, status: number | undefined, attempts: number) {
    super(`AI call failed (${kind}${status ? ` ${status}` : ""}) after ${attempts} attempt(s)`);
    this.name = "AiCallError";
    this.kind = kind;
    this.status = status;
    this.attempts = attempts;
  }
}

export interface AiClientOptions {
  readonly transport: ModelTransport;
  /** Metering hook (`ai_runs`). Errors thrown here never fail the model call. */
  readonly onRun?: (record: AiRunRecord) => void | Promise<void>;
  /** Injected so tests do not wait. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Monotonic millisecond clock for latency only (never calendar logic). */
  readonly now?: () => number;
}

export interface CompleteInput<T> {
  readonly purpose: AiPurpose;
  readonly promptVersion: string;
  readonly request: ModelRequest;
  readonly householdId?: string | null;
  readonly reference?: string | null;
  /** Turns model text into a value; throw to mark the output `invalid_output`. Runs only after stop_reason is checked. */
  readonly parse: (text: string) => T;
}

export type Completion<T> =
  | { readonly status: "ok"; readonly value: T; readonly usage: TokenUsage; readonly stopReason: string }
  | { readonly status: "refusal"; readonly category: string | null; readonly usage: TokenUsage }
  | {
      readonly status: "invalid_output";
      readonly reason: "max_tokens" | "unexpected_stop" | "parse_failed";
      readonly usage: TokenUsage;
      readonly stopReason: string | null;
    };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function classify(error: unknown): {
  kind: AiErrorKind;
  status: number | undefined;
  retryAfterMs: number | null;
} {
  // Most specific first: RateLimitError, then 5xx, then connection failures, then every other 4xx.
  if (error instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limited", status: error.status, retryAfterMs: retryAfter(error.headers) };
  }
  if (error instanceof Anthropic.InternalServerError) {
    return { kind: "server_error", status: error.status, retryAfterMs: retryAfter(error.headers) };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: "connection", status: undefined, retryAfterMs: null };
  }
  if (error instanceof Anthropic.APIError) {
    return { kind: "client_error", status: error.status, retryAfterMs: null };
  }
  throw error; // not an SDK error: a bug, not something to retry
}

function retryAfter(headers: Headers | undefined): number | null {
  const raw = headers?.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

export class AiClient {
  private readonly transport: ModelTransport;
  private readonly onRun: AiClientOptions["onRun"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: AiClientOptions) {
    this.transport = options.transport;
    this.onRun = options.onRun;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => performance.now());
  }

  get modelTransport(): ModelTransport {
    return this.transport;
  }

  /** Sends with retry, checks stop_reason, then (and only then) parses the text. */
  async complete<T>(input: CompleteInput<T>): Promise<Completion<T>> {
    const started = this.now();
    let response: ModelResponse;
    try {
      response = await this.sendWithRetry(input.request);
    } catch (error) {
      await this.meter(input, null, "error", started, false);
      throw error;
    }
    const completion = this.interpret(response, input.parse);
    await this.meter(input, response, completion.status, started, false);
    return completion;
  }

  /** Same stop_reason and parsing rules for a response that arrived through the Batch API. */
  interpret<T>(response: ModelResponse, parse: (text: string) => T): Completion<T> {
    const { stopReason, usage } = response;
    if (stopReason === "refusal") {
      return { status: "refusal", category: response.stopCategory, usage };
    }
    if (stopReason === "max_tokens") {
      return { status: "invalid_output", reason: "max_tokens", usage, stopReason };
    }
    if (stopReason !== "end_turn") {
      // tool_use, pause_turn, compaction, null...: none are valid for a no-tools single-shot call.
      return { status: "invalid_output", reason: "unexpected_stop", usage, stopReason };
    }
    try {
      return { status: "ok", value: parse(response.text), usage, stopReason };
    } catch {
      return { status: "invalid_output", reason: "parse_failed", usage, stopReason };
    }
  }

  /** Records one metered run. Used directly for batch results. */
  async meter(
    input: Pick<
      CompleteInput<unknown>,
      "purpose" | "promptVersion" | "request" | "householdId" | "reference"
    >,
    response: ModelResponse | null,
    status: AiRunStatus,
    startedAt: number,
    batch: boolean,
  ): Promise<void> {
    if (!this.onRun) return;
    const usage = response?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = priceModel(response?.model ?? input.request.model, usage, batch, input.request.model);
    const record: AiRunRecord = {
      householdId: input.householdId ?? null,
      reference: input.reference ?? null,
      purpose: input.purpose,
      modelId: response?.model ?? input.request.model,
      promptVersion: input.promptVersion,
      batch,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costMicros: cost.micros,
      costEstimated: cost.estimated,
      stopReason: response?.stopReason ?? null,
      latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
      status,
    };
    try {
      await this.onRun(record);
    } catch {
      // Metering must never fail a user-facing call.
    }
  }

  /** Monotonic ms clock, exposed so batch metering shares the injected clock. */
  clock(): number {
    return this.now();
  }

  /** Batch calls get the same retry policy as single calls (L5). */
  createBatch(entries: readonly { customId: string; request: ModelRequest }[]): Promise<{ id: string }> {
    return this.withRetry(() => this.transport.createBatch(entries));
  }

  batchStatus(id: string): Promise<BatchStatus> {
    return this.withRetry(() => this.transport.getBatchStatus(id));
  }

  batchResults(id: string): Promise<BatchOutcome[]> {
    return this.withRetry(() => this.transport.getBatchResults(id));
  }

  private sendWithRetry(request: ModelRequest): Promise<ModelResponse> {
    return this.withRetry(() => this.transport.send(request));
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const { kind, status, retryAfterMs } = classify(error);
        // 408 and 409 are deliberately NOT retried: they classify as client errors and fail at once.
        const retryable = kind !== "client_error";
        if (!retryable || attempt >= RETRY.maxAttempts) {
          throw new AiCallError(kind, status, attempt);
        }
        const backoff = Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * 2 ** (attempt - 1));
        await this.sleep(Math.min(RETRY.maxDelayMs, retryAfterMs ?? backoff));
      }
    }
  }
}
