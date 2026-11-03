import type { TokenUsage } from "../pricing";
import type { BatchOutcome, BatchStatus, ModelRequest, ModelResponse, ModelTransport } from "../transport";

// Fake model transport for tests and offline evals. It never touches the network: a test supplies a responder
// function (or a queue of scripted results) and can inspect every request that was sent.

export type Responder = (
  request: ModelRequest,
  callIndex: number,
) => ModelResponse | Error | Promise<ModelResponse | Error>;

export const DEFAULT_FAKE_USAGE: TokenUsage = {
  inputTokens: 1_500,
  outputTokens: 220,
  cacheReadTokens: 1_200,
  cacheWriteTokens: 0,
};

export function textResponse(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    stopReason: "end_turn",
    stopCategory: null,
    text,
    usage: DEFAULT_FAKE_USAGE,
    model: "claude-opus-5-5",
    ...overrides,
  };
}

export function jsonResponse(value: unknown, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return textResponse(JSON.stringify(value), overrides);
}

export function refusalResponse(category: string | null = "general_harms"): ModelResponse {
  return textResponse("", { stopReason: "refusal", stopCategory: category });
}

export interface FakeTransport extends ModelTransport {
  /** Every request passed to `send`, in order (retries included). */
  readonly sent: ModelRequest[];
  /** Every batch created, by id. */
  readonly batches: Map<string, { customId: string; request: ModelRequest }[]>;
}

export interface FakeTransportOptions {
  readonly responder: Responder;
  /** Number of `getBatchStatus` calls that report `in_progress` before `ended`. Default 0. */
  readonly batchPollsBeforeEnd?: number;
  /** Override batch outcomes; by default each entry is answered through `responder`. */
  readonly batchOutcomes?: (
    entries: readonly { customId: string; request: ModelRequest }[],
  ) => BatchOutcome[];
}

export function createFakeTransport(options: FakeTransportOptions): FakeTransport {
  const sent: ModelRequest[] = [];
  const batches = new Map<string, { customId: string; request: ModelRequest }[]>();
  const polls = new Map<string, number>();
  let calls = 0;

  return {
    sent,
    batches,
    async send(request) {
      sent.push(request);
      const result = await options.responder(request, calls++);
      if (result instanceof Error) throw result;
      return result;
    },
    async createBatch(entries) {
      const id = `batch_fake_${batches.size + 1}`;
      batches.set(id, [...entries]);
      polls.set(id, 0);
      return { id };
    },
    async getBatchStatus(id): Promise<BatchStatus> {
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      return n > (options.batchPollsBeforeEnd ?? 0) ? "ended" : "in_progress";
    },
    async getBatchResults(id) {
      const entries = batches.get(id) ?? [];
      if (options.batchOutcomes) return options.batchOutcomes(entries);
      const outcomes: BatchOutcome[] = [];
      for (const entry of entries) {
        const result = await options.responder(entry.request, calls++);
        outcomes.push(
          result instanceof Error
            ? { customId: entry.customId, kind: "errored", detail: "fake_error" }
            : { customId: entry.customId, kind: "succeeded", response: result },
        );
      }
      return outcomes;
    },
  };
}

/** Responder that returns the given results in order, then repeats the last one. */
export function scripted(...results: (ModelResponse | Error)[]): Responder {
  return (_request, index) => {
    const result = results[Math.min(index, results.length - 1)];
    if (!result) throw new Error("scripted() needs at least one result");
    return result;
  };
}
