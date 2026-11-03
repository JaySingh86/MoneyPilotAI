import Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_BETA, INFERENCE_GEO, TIMEOUT_MS } from "./config";
import type { TokenUsage } from "./pricing";
import type { BatchOutcome, BatchStatus, ModelRequest, ModelResponse, ModelTransport } from "./transport";

// The only file in the repo that talks to the Anthropic SDK. Credentials come from the environment
// (ANTHROPIC_API_KEY, resolved by the SDK); there is no key in code, tests or config.

/**
 * Builds the SDK client with SDK-level retries off: `AiClient` owns retry and backoff so it can meter every
 * attempt and honour its own attempt cap.
 */
export function createAnthropicClient(options: { apiKey?: string } = {}): Anthropic {
  return new Anthropic({ ...(options.apiKey ? { apiKey: options.apiKey } : {}), maxRetries: 0 });
}

interface RawMessage {
  readonly stop_reason: string | null;
  readonly stop_details?: { readonly category?: string | null } | null;
  readonly content: ReadonlyArray<{ readonly type: string }>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  };
  readonly model: string;
}

function toUsage(usage: RawMessage["usage"]): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function toResponse(message: RawMessage): ModelResponse {
  // stop_reason is read first by the caller; text is only collected here, never trusted before that check.
  const text = message.content
    .map((block) =>
      block.type === "text" && "text" in block ? String((block as { text: unknown }).text) : "",
    )
    .join("");
  return {
    stopReason: message.stop_reason,
    stopCategory: message.stop_details?.category ?? null,
    text,
    usage: toUsage(message.usage),
    model: message.model,
  };
}

function systemBlocks(system: string) {
  // The frozen prompt is the cache prefix; the volatile email comes after it in the user turn.
  return [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }];
}

export function createSdkTransport(client: Anthropic): ModelTransport {
  return {
    async send(request: ModelRequest): Promise<ModelResponse> {
      // Single calls go through the beta endpoint because `fallbacks` (refusal rescue) lives there.
      const message = await client.beta.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: systemBlocks(request.system),
          messages: [{ role: "user", content: request.user }],
          output_config: {
            effort: request.effort,
            ...(request.jsonSchema
              ? { format: { type: "json_schema", schema: { ...request.jsonSchema } } }
              : {}),
          },
          inference_geo: INFERENCE_GEO,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { timeout: TIMEOUT_MS.send },
      );
      return toResponse(message);
    },

    async createBatch(entries) {
      // `fallbacks` is rejected on the Batches API, so backfill requests run on the primary model only.
      const batch = await client.messages.batches.create(
        {
          requests: entries.map(({ customId, request }) => ({
            custom_id: customId,
            params: {
              model: request.model,
              max_tokens: request.maxTokens,
              system: systemBlocks(request.system),
              messages: [{ role: "user" as const, content: request.user }],
              output_config: {
                effort: request.effort,
                ...(request.jsonSchema
                  ? { format: { type: "json_schema" as const, schema: { ...request.jsonSchema } } }
                  : {}),
              },
              inference_geo: INFERENCE_GEO,
            },
          })),
        },
        { timeout: TIMEOUT_MS.batch },
      );
      return { id: batch.id };
    },

    async getBatchStatus(id: string): Promise<BatchStatus> {
      const batch = await client.messages.batches.retrieve(id, undefined, { timeout: TIMEOUT_MS.batch });
      return batch.processing_status;
    },

    async getBatchResults(id: string): Promise<BatchOutcome[]> {
      const outcomes: BatchOutcome[] = [];
      for await (const item of await client.messages.batches.results(id, undefined, {
        timeout: TIMEOUT_MS.batch,
      })) {
        const result = item.result;
        if (result.type === "succeeded") {
          outcomes.push({
            customId: item.custom_id,
            kind: "succeeded",
            response: toResponse(result.message),
          });
        } else if (result.type === "errored") {
          outcomes.push({ customId: item.custom_id, kind: "errored", detail: result.error.error.type });
        } else {
          outcomes.push({ customId: item.custom_id, kind: result.type, detail: result.type });
        }
      }
      return outcomes;
    },
  };
}
