import type { Effort } from "./config";
import type { TokenUsage } from "./pricing";

// The seam between our code and the model provider. The real implementation (sdk-transport.ts) wraps
// @anthropic-ai/sdk; the fake in src/testing implements the same interface, so no test touches the network.
// No request type here has a `tools` field: email content never reaches a model that has tools (CLAUDE.md rule 9).

export interface ModelRequest {
  readonly model: string;
  readonly effort: Effort;
  readonly maxTokens: number;
  /** Frozen, versioned system prompt. Sent as a cached block. */
  readonly system: string;
  /** Volatile content, always last so it never invalidates the cached prefix. */
  readonly user: string;
  /** When set, sent as `output_config.format` (structured output). */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface ModelResponse {
  /** Provider stop reason, e.g. `end_turn`, `max_tokens`, `refusal`. Always checked before `text` is read. */
  readonly stopReason: string | null;
  /** Refusal category when `stopReason` is `refusal` (open set). */
  readonly stopCategory: string | null;
  /** Concatenated text blocks. Only meaningful when `stopReason` is `end_turn`. */
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
}

export type BatchOutcome =
  | { readonly customId: string; readonly kind: "succeeded"; readonly response: ModelResponse }
  | { readonly customId: string; readonly kind: "errored" | "canceled" | "expired"; readonly detail: string };

export type BatchStatus = "in_progress" | "canceling" | "ended";

export interface ModelTransport {
  send(request: ModelRequest): Promise<ModelResponse>;
  createBatch(entries: readonly { customId: string; request: ModelRequest }[]): Promise<{ id: string }>;
  getBatchStatus(id: string): Promise<BatchStatus>;
  getBatchResults(id: string): Promise<BatchOutcome[]>;
}
