import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AiCallError, AiClient } from "./client";
import type { AiRunRecord } from "./client";
import { costMicros } from "./pricing";
import type { ModelRequest } from "./transport";
import { createFakeTransport, jsonResponse, refusalResponse, scripted, textResponse } from "./testing";

const REQUEST: ModelRequest = {
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 100,
  system: "sys",
  user: "user",
};
const parseJson = (text: string): unknown => JSON.parse(text);

function setup(responder: Parameters<typeof createFakeTransport>[0]["responder"]) {
  const transport = createFakeTransport({ responder });
  const runs: AiRunRecord[] = [];
  const sleeps: number[] = [];
  let tick = 0;
  const client = new AiClient({
    transport,
    onRun: (r) => {
      runs.push(r);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => (tick += 10),
  });
  const complete = () =>
    client.complete({
      purpose: "extract",
      promptVersion: "extract.v1",
      request: REQUEST,
      householdId: "h1",
      parse: parseJson,
    });
  return { transport, runs, sleeps, complete };
}

const rateLimit = (retryAfter?: string) =>
  new Anthropic.RateLimitError(
    429,
    {},
    "rate limited",
    new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
  );
const serverError = () => new Anthropic.InternalServerError(529, {}, "overloaded", new Headers());
const badRequest = () => new Anthropic.BadRequestError(400, {}, "bad", new Headers());

describe("AiClient.complete: stop_reason handling", () => {
  it("parses text only after end_turn", async () => {
    const { complete, runs } = setup(scripted(jsonResponse({ a: 1 })));
    expect(await complete()).toMatchObject({ status: "ok", value: { a: 1 } });
    expect(runs[0]).toMatchObject({
      status: "ok",
      purpose: "extract",
      householdId: "h1",
      batch: false,
      stopReason: "end_turn",
    });
  });

  it("returns a refusal without reading content", async () => {
    const { complete, runs } = setup(
      scripted(textResponse('{"a":1}', { stopReason: "refusal", stopCategory: "cyber" })),
    );
    expect(await complete()).toMatchObject({ status: "refusal", category: "cyber" });
    expect(runs[0]?.status).toBe("refusal");
  });

  it("treats max_tokens as invalid output, not as a parse attempt", async () => {
    const { complete } = setup(scripted(textResponse('{"a":1}', { stopReason: "max_tokens" })));
    expect(await complete()).toMatchObject({ status: "invalid_output", reason: "max_tokens" });
  });

  it.each(["tool_use", "pause_turn", null])("rejects unexpected stop_reason %s", async (stop) => {
    const { complete } = setup(scripted(textResponse("{}", { stopReason: stop })));
    expect(await complete()).toMatchObject({ status: "invalid_output", reason: "unexpected_stop" });
  });

  it("marks unparsable text as invalid_output", async () => {
    const { complete, runs } = setup(scripted(textResponse("not json")));
    expect(await complete()).toMatchObject({ status: "invalid_output", reason: "parse_failed" });
    expect(runs[0]?.status).toBe("invalid_output");
  });
});

describe("AiClient.complete: typed SDK errors", () => {
  it("retries RateLimitError with backoff and then succeeds", async () => {
    const { complete, sleeps, transport } = setup(
      scripted(rateLimit(), rateLimit(), jsonResponse({ ok: true })),
    );
    expect(await complete()).toMatchObject({ status: "ok" });
    expect(transport.sent).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("honours retry-after", async () => {
    const { complete, sleeps } = setup(scripted(rateLimit("3"), jsonResponse({ ok: true })));
    await complete();
    expect(sleeps).toEqual([3000]);
  });

  it("retries 5xx and connection errors", async () => {
    const { complete, transport } = setup(
      scripted(serverError(), new Anthropic.APIConnectionError({ message: "reset" }), jsonResponse({})),
    );
    expect(await complete()).toMatchObject({ status: "ok" });
    expect(transport.sent).toHaveLength(3);
  });

  it("gives up after the attempt cap and meters an error run", async () => {
    const { complete, transport, runs } = setup(scripted(rateLimit()));
    await expect(complete()).rejects.toMatchObject({
      name: "AiCallError",
      kind: "rate_limited",
      attempts: 4,
    });
    expect(transport.sent).toHaveLength(4);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "error", inputTokens: 0 });
  });

  it("fails 4xx immediately without retrying", async () => {
    const { complete, transport, sleeps } = setup(scripted(badRequest()));
    const error = await complete().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiCallError);
    expect(error).toMatchObject({ kind: "client_error", status: 400, attempts: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not swallow non-SDK errors", async () => {
    const { complete } = setup(scripted(new TypeError("bug")));
    await expect(complete()).rejects.toBeInstanceOf(TypeError);
  });
});

describe("metering (ai_runs)", () => {
  it("records tokens, cost and latency but no content", async () => {
    const { complete, runs } = setup(scripted(jsonResponse({ secret: "Amount due: $142.18" })));
    await complete();
    const run = runs[0] as AiRunRecord;
    expect(run).toMatchObject({
      inputTokens: 1500,
      outputTokens: 220,
      cacheReadTokens: 1200,
      modelId: "claude-opus-5-5",
      promptVersion: "extract.v1",
    });
    expect(run.costMicros).toBeGreaterThan(0);
    expect(run.latencyMs).toBeGreaterThan(0);
    expect(JSON.stringify(run)).not.toContain("142.18");
  });

  it("a failing metering callback never fails the call", async () => {
    const client = new AiClient({
      transport: createFakeTransport({ responder: scripted(jsonResponse({})) }),
      onRun: () => {
        throw new Error("db down");
      },
    });
    const result = await client.complete({
      purpose: "extract",
      promptVersion: "extract.v1",
      request: REQUEST,
      parse: parseJson,
    });
    expect(result.status).toBe("ok");
  });

  it("prices integer micro-dollars and halves batch calls", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    expect(costMicros("claude-opus-5-5", usage, false)).toBe(24_200_000);
    expect(costMicros("claude-opus-5-5", usage, true)).toBe(12_100_000);
    expect(costMicros("unknown-model", usage, false)).toBe(0);
  });

  it("refusalResponse sets a refusal stop reason", () => {
    expect(refusalResponse("bio")).toMatchObject({ stopReason: "refusal", stopCategory: "bio" });
  });
});
