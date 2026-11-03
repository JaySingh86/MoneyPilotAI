import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { INFERENCE_GEO } from "./config";
import { createSdkTransport } from "./sdk-transport";
import type { ModelRequest } from "./transport";

// A stub of the SDK surface the transport uses. Nothing here touches the network.
const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  stop_details: null,
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: '{"ok":' },
    { type: "text", text: "true}" },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: null,
  },
};

function stub() {
  const calls: {
    single: Record<string, unknown>[];
    batch: Record<string, unknown>[];
    options: Record<string, unknown>[];
  } = { single: [], batch: [], options: [] };
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.single.push(params);
          calls.options.push(options);
          return MESSAGE;
        },
      },
    },
    messages: {
      batches: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.batch.push(params);
          calls.options.push(options);
          return { id: "msgbatch_1" };
        },
        retrieve: async (_id: string, _params: unknown, options: Record<string, unknown>) => {
          calls.options.push(options);
          return { processing_status: "ended" };
        },
        results: async (_id: string, _params: unknown, options: Record<string, unknown>) => {
          calls.options.push(options);
          return (async function* () {
            yield { custom_id: "a", result: { type: "succeeded", message: MESSAGE } };
            yield {
              custom_id: "b",
              result: {
                type: "errored",
                error: { type: "error", error: { type: "overloaded_error", message: "x" } },
              },
            };
            yield { custom_id: "c", result: { type: "expired" } };
          })();
        },
      },
    },
  } as unknown as Anthropic;
  return { transport: createSdkTransport(client), calls };
}

const REQUEST: ModelRequest = {
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 4096,
  system: "frozen system prompt",
  user: "<email>data</email>",
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
};

describe("SDK request standards (CLAUDE.md 'AI in product code')", () => {
  it("sends the required parameters and nothing forbidden", async () => {
    const { transport, calls } = stub();
    await transport.send(REQUEST);
    const params = calls.single[0] as Record<string, unknown>;
    expect(params["model"]).toBe("claude-opus-5-5");
    expect(params["inference_geo"]).toBe(INFERENCE_GEO);
    expect(params["inference_geo"]).toBe("us");
    expect(params["output_config"]).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: REQUEST.jsonSchema },
    });
    expect(params["fallbacks"]).toBe("default");
    expect(params["betas"]).toEqual(["server-side-fallback-2026-07-01"]);
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tools", "tool_choice"]) {
      expect(params).not.toHaveProperty(forbidden);
    }
  });

  it("caches the system prompt and keeps the email last", async () => {
    const { transport, calls } = stub();
    await transport.send(REQUEST);
    const params = calls.single[0] as { system: unknown; messages: unknown };
    expect(params.system).toEqual([
      { type: "text", text: "frozen system prompt", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages).toEqual([{ role: "user", content: "<email>data</email>" }]);
  });

  it("returns text blocks only, with null cache fields as zero", async () => {
    const { transport } = stub();
    const response = await transport.send(REQUEST);
    expect(response.text).toBe('{"ok":true}');
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
    });
  });

  it("omits the format when no schema is given", async () => {
    const { transport, calls } = stub();
    await transport.send({ ...REQUEST, effort: "medium", jsonSchema: undefined });
    expect((calls.single[0] as { output_config: unknown }).output_config).toEqual({ effort: "medium" });
  });
});

describe("timeouts (L5)", () => {
  it("every network call carries a per-request timeout", async () => {
    const { transport, calls } = stub();
    await transport.send(REQUEST);
    await transport.createBatch([{ customId: "a", request: REQUEST }]);
    await transport.getBatchStatus("x");
    await transport.getBatchResults("x");
    expect(calls.options).toHaveLength(4);
    for (const options of calls.options) {
      expect(options["timeout"]).toBeGreaterThan(0);
    }
  });
});

describe("batch requests", () => {
  it("uses the non-beta batches endpoint with no fallbacks, in us, without temperature or tools", async () => {
    const { transport, calls } = stub();
    const { id } = await transport.createBatch([{ customId: "msg-1", request: REQUEST }]);
    expect(id).toBe("msgbatch_1");
    const requests = (
      calls.batch[0] as { requests: { custom_id: string; params: Record<string, unknown> }[] }
    ).requests;
    expect(requests[0]?.custom_id).toBe("msg-1");
    const params = requests[0]?.params as Record<string, unknown>;
    expect(params["inference_geo"]).toBe("us");
    for (const forbidden of ["fallbacks", "temperature", "tools"])
      expect(params).not.toHaveProperty(forbidden);
  });

  it("maps results by custom_id and reports non-success kinds", async () => {
    const { transport } = stub();
    expect(await transport.getBatchStatus("x")).toBe("ended");
    const outcomes = await transport.getBatchResults("x");
    expect(outcomes.map((o) => [o.customId, o.kind])).toEqual([
      ["a", "succeeded"],
      ["b", "errored"],
      ["c", "expired"],
    ]);
  });
});
