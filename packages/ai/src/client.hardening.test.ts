import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AiCallError, AiClient } from "./client";
import type { AiRunRecord } from "./client";
import { PRICING } from "./config";
import { costMicros, priceModel } from "./pricing";
import type { ModelRequest, ModelTransport } from "./transport";
import { createFakeTransport, jsonResponse, scripted } from "./testing";

// Security review L3 (never price at 0) and L5 (retry batch calls).

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
const REQUEST: ModelRequest = {
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 100,
  system: "s",
  user: "u",
};

describe("L3: cost is an estimate and never 0", () => {
  it("prices a model that is not in the table by the requested model", () => {
    const priced = priceModel("claude-future-9", usage, false, "claude-opus-5-5");
    expect(priced.estimated).toBe(true);
    expect(priced.micros).toBe(costMicros("claude-opus-5-5", usage, false));
    expect(priced.micros).toBeGreaterThan(0);
  });

  it("falls back to the highest known rate when the requested model is unknown too", () => {
    const priced = priceModel("x", usage, false, "y");
    const highest = Math.max(...Object.values(PRICING).map((p) => p.outputMicrosPerMTok));
    expect(priced.estimated).toBe(true);
    expect(priced.micros).toBeGreaterThanOrEqual(highest);
  });

  it("a known model is not flagged", () => {
    expect(priceModel("claude-opus-5-5", usage, false, "claude-opus-5-5").estimated).toBe(false);
  });

  it("the metering record carries the flag", async () => {
    const runs: AiRunRecord[] = [];
    const transport = createFakeTransport({
      responder: scripted(jsonResponse({}, { model: "claude-brand-new" }), jsonResponse({})),
    });
    const client = new AiClient({ transport, onRun: (r) => void runs.push(r) });
    const input = {
      purpose: "extract" as const,
      promptVersion: "extract.v1",
      request: REQUEST,
      parse: JSON.parse,
    };
    await client.complete(input);
    await client.complete(input);
    expect(runs[0]).toMatchObject({ modelId: "claude-brand-new", costEstimated: true });
    expect(runs[0]?.costMicros).toBeGreaterThan(0);
    expect(runs[1]).toMatchObject({ costEstimated: false });
  });
});

describe("L5: batch calls are retried", () => {
  const rateLimit = () => new Anthropic.RateLimitError(429, {}, "slow down", new Headers());
  const flaky = (failures: Error[]): { transport: ModelTransport; calls: string[] } => {
    const calls: string[] = [];
    const base = createFakeTransport({ responder: scripted(jsonResponse({})) });
    const pending = [...failures];
    const wrap =
      <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        calls.push(name);
        const next = pending.shift();
        if (next) throw next;
        return fn(...args);
      };
    return {
      calls,
      transport: {
        send: base.send,
        createBatch: wrap("create", base.createBatch),
        getBatchStatus: wrap("status", base.getBatchStatus),
        getBatchResults: wrap("results", base.getBatchResults),
      },
    };
  };
  const make = (failures: Error[]) => {
    const { transport, calls } = flaky(failures);
    const sleeps: number[] = [];
    const client = new AiClient({ transport, sleep: async (ms) => void sleeps.push(ms) });
    return { client, calls, sleeps };
  };

  it("retries createBatch, status and results on rate limits and 5xx", async () => {
    const { client, calls } = make([rateLimit()]);
    await expect(client.createBatch([{ customId: "a", request: REQUEST }])).resolves.toMatchObject({
      id: "batch_fake_1",
    });
    expect(calls).toEqual(["create", "create"]);

    const s = make([new Anthropic.InternalServerError(500, {}, "x", new Headers()), rateLimit()]);
    await expect(s.client.batchStatus("b")).resolves.toBe("ended");
    expect(s.calls).toEqual(["status", "status", "status"]);
    expect(s.sleeps).toEqual([500, 1000]);

    const r = make([new Anthropic.APIConnectionError({ message: "reset" })]);
    await expect(r.client.batchResults("b")).resolves.toEqual([]);
  });

  it("fails 4xx at once and gives up after the attempt cap", async () => {
    const bad = make([new Anthropic.NotFoundError(404, {}, "gone", new Headers())]);
    await expect(bad.client.batchStatus("b")).rejects.toBeInstanceOf(AiCallError);
    expect(bad.calls).toHaveLength(1);

    const tired = make([rateLimit(), rateLimit(), rateLimit(), rateLimit(), rateLimit()]);
    await expect(tired.client.batchResults("b")).rejects.toMatchObject({ kind: "rate_limited", attempts: 4 });
    expect(tired.calls).toHaveLength(4);
  });

  it("408 and 409 are deliberately not retried", async () => {
    const timeout = make([new Anthropic.APIError(408, {}, "timeout", new Headers())]);
    await expect(timeout.client.batchStatus("b")).rejects.toMatchObject({
      kind: "client_error",
      status: 408,
    });
    expect(timeout.calls).toHaveLength(1);
  });
});
