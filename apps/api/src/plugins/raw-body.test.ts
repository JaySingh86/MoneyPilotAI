import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { expectProblem, testServer } from "../lib/testing";
import type { ApiServer } from "../server";
import { rawBody } from "./raw-body";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

const routes: FastifyPluginAsyncZod = async (scope) => {
  await scope.register(async (hooks) => {
    await hooks.register(rawBody);
    hooks.post("/webhooks/test", { config: { idempotency: "off" } }, async (request) => ({
      raw: request.rawBody?.toString("utf8") ?? null,
      body: request.body ?? null,
    }));
  });
  scope.post("/plain", { config: { idempotency: "off" } }, async (request) => ({
    raw: request.rawBody ?? null,
    body: request.body,
  }));
};

describe("rawBody", () => {
  it("keeps the exact JSON bytes and the parsed body", async () => {
    app = testServer(routes);
    const payload = '{ "b": 1,  "a": [2] }';
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.json()).toEqual({ raw: payload, body: { b: 1, a: [2] } });
  });

  it("keeps text/plain (SNS) as a string", async () => {
    app = testServer(routes);
    const payload = '{"Type":"Notification"}';
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { "content-type": "text/plain; charset=UTF-8" },
      payload,
    });
    expect(res.json()).toEqual({ raw: payload, body: payload });
  });

  it("answers malformed JSON with a problem", async () => {
    app = testServer(routes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { "content-type": "application/json" },
      payload: "{nope",
    });
    expectProblem(res, 400, "validation_failed");
  });

  it("does not leak outside its scope", async () => {
    app = testServer(routes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/plain",
      headers: { "content-type": "application/json" },
      payload: '{"a":1}',
    });
    expect(res.json()).toEqual({ raw: null, body: { a: 1 } });
  });

  it.each(['{"__proto__":{"admin":true}}', '{"a":{"constructor":{"prototype":{"admin":true}}}}'])(
    "rejects prototype poisoning: %s",
    async (payload) => {
      app = testServer(routes);
      const res = await app.inject({
        method: "POST",
        url: "/v1/webhooks/test",
        headers: { "content-type": "application/json" },
        payload,
      });
      expectProblem(res, 400, "validation_failed");
    },
  );
});
