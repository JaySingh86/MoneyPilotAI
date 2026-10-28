import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@mp/contracts";
import {
  IDEMPOTENCY_TTL_MS,
  InMemoryIdempotencyStore,
  MAX_STORED_BODY_BYTES,
} from "../lib/idempotency-store";
import { bearer, expectProblem, testServer, USER_A, USER_B } from "../lib/testing";
import type { ApiServer } from "../server";
import { canonicalJson, requestFingerprint } from "./idempotency";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

function setup(options: { now?: () => number; store?: InMemoryIdempotencyStore } = {}) {
  const calls = { create: 0, fail: 0, reject: 0, slow: 0 };
  let releaseSlow: () => void = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const routes: FastifyPluginAsyncZod = async (scope) => {
    scope.post(
      "/goals",
      {
        schema: {
          body: z.object({ name: z.string(), targetCents: z.number().int() }),
          response: { 201: z.object({ id: z.number(), name: z.string() }) },
        },
        config: { idempotency: "required" },
      },
      async (request, reply) => {
        calls.create += 1;
        return reply
          .code(201)
          .header("location", `/v1/goals/${calls.create}`)
          .send({ id: calls.create, name: request.body.name });
      },
    );
    scope.post("/notes", { config: { idempotency: "optional" } }, async () => {
      calls.create += 1;
      return { n: calls.create };
    });
    scope.post("/fail", { config: { idempotency: "optional" } }, async () => {
      calls.fail += 1;
      if (calls.fail === 1) throw new Error("database went away");
      return { attempt: calls.fail };
    });
    scope.post("/reject", { config: { idempotency: "optional" } }, async () => {
      calls.reject += 1;
      throw new AppError("conflict", 409, "Already done.");
    });
    scope.post("/slow", { config: { idempotency: "optional" } }, async () => {
      calls.slow += 1;
      await slowGate;
      return { done: true };
    });
    scope.post("/big", { config: { idempotency: "required" } }, async (_request, reply) => {
      calls.create += 1;
      return reply
        .code(201)
        .header("location", "/v1/big/1")
        .send({ blob: "x".repeat(MAX_STORED_BODY_BYTES) });
    });
    scope.get("/read", async () => {
      calls.create += 1;
      return { n: calls.create };
    });
  };
  const store = options.store ?? new InMemoryIdempotencyStore();
  app = testServer(routes, { idempotencyStore: store, ...(options.now ? { now: options.now } : {}) });
  return { calls, releaseSlow: () => releaseSlow(), store };
}

function post(url: string, key: string | undefined, payload: unknown, userId = USER_A) {
  return app.inject({
    method: "POST",
    url,
    headers: { ...bearer(userId), ...(key ? { "idempotency-key": key } : {}) },
    payload: payload as Record<string, unknown>,
  });
}

describe("Idempotency-Key (WP-08 acceptance)", () => {
  it("repeating a POST with the same key returns the stored response", async () => {
    const { calls } = setup();
    const first = await post("/v1/goals", "key-1", { name: "Emergency fund", targetCents: 500000 });
    const second = await post("/v1/goals", "key-1", { name: "Emergency fund", targetCents: 500000 });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls.create).toBe(1);
  });

  it("a different body with the same key returns 422", async () => {
    const { calls } = setup();
    await post("/v1/goals", "key-1", { name: "Emergency fund", targetCents: 500000 });
    const res = await post("/v1/goals", "key-1", { name: "Vacation", targetCents: 500000 });
    expectProblem(res, 422, "idempotency_key_reused");
    expect(calls.create).toBe(1);
  });

  it("the same key on a different path is a different request (422)", async () => {
    setup();
    await post("/v1/goals", "key-1", { name: "a", targetCents: 1 });
    expectProblem(
      await post("/v1/notes", "key-1", { name: "a", targetCents: 1 }),
      422,
      "idempotency_key_reused",
    );
  });

  it("ignores object key order when fingerprinting the body", async () => {
    const { calls } = setup();
    await post("/v1/goals", "key-1", { name: "a", targetCents: 1 });
    const res = await post("/v1/goals", "key-1", { targetCents: 1, name: "a" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(calls.create).toBe(1);
  });

  it("scopes keys per user", async () => {
    const { calls } = setup();
    await post("/v1/goals", "key-1", { name: "a", targetCents: 1 }, USER_A);
    const res = await post("/v1/goals", "key-1", { name: "b", targetCents: 1 }, USER_B);
    expect(res.statusCode).toBe(201);
    expect(calls.create).toBe(2);
  });

  it("requires the key where the route says so", async () => {
    setup();
    const res = await post("/v1/goals", undefined, { name: "a", targetCents: 1 });
    const problem = expectProblem(res, 400, "validation_failed");
    expect(problem.fields).toEqual([{ in: "headers", path: "Idempotency-Key", message: expect.any(String) }]);
  });

  it("rejects a malformed key", async () => {
    setup();
    expectProblem(
      await post("/v1/goals", "has spaces", { name: "a", targetCents: 1 }),
      400,
      "validation_failed",
    );
    expectProblem(
      await post("/v1/goals", "x".repeat(256), { name: "a", targetCents: 1 }),
      400,
      "validation_failed",
    );
  });

  it("is optional on other writes and never applies to reads", async () => {
    const { calls } = setup();
    expect((await post("/v1/notes", undefined, {})).statusCode).toBe(200);
    expect((await post("/v1/notes", undefined, {})).statusCode).toBe(200);
    const read = () =>
      app.inject({ url: "/v1/read", headers: { ...bearer(USER_A), "idempotency-key": "r" } });
    expect((await read()).json()).toEqual({ n: 3 });
    expect((await read()).json()).toEqual({ n: 4 });
    expect(calls.create).toBe(4);
  });

  it("does not store client errors (e.g. after step-up MFA the retry must run again)", async () => {
    const { calls, store } = setup();
    const first = await post("/v1/reject", "key-r", {});
    const second = await post("/v1/reject", "key-r", {});
    expectProblem(first, 409, "conflict");
    expectProblem(second, 409, "conflict");
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls.reject).toBe(2);
    expect(store.size).toBe(0);
  });

  it("does not store server errors, so the client can retry with the same key", async () => {
    const { calls, store } = setup();
    expectProblem(await post("/v1/fail", "key-f", {}), 500, "internal_error");
    expect(store.size).toBe(0);
    const retry = await post("/v1/fail", "key-f", {});
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ attempt: 2 });
    expect(calls.fail).toBe(2);
  });

  it("answers 409 while the first request with the key is still running", async () => {
    const { releaseSlow } = setup();
    const first = post("/v1/slow", "key-s", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expectProblem(await post("/v1/slow", "key-s", {}), 409, "conflict");
    releaseSlow();
    expect((await first).statusCode).toBe(200);
    expect((await post("/v1/slow", "key-s", {})).headers["idempotent-replayed"]).toBe("true");
  });

  it("forgets keys after 24 hours", async () => {
    let now = Date.UTC(2026, 9, 27, 12);
    const { calls } = setup({ now: () => now });
    await post("/v1/goals", "key-1", { name: "a", targetCents: 1 });
    now += IDEMPOTENCY_TTL_MS - 1;
    expect(
      (await post("/v1/goals", "key-1", { name: "a", targetCents: 1 })).headers["idempotent-replayed"],
    ).toBe("true");
    now += 1;
    const late = await post("/v1/goals", "key-1", { name: "b", targetCents: 1 });
    expect(late.statusCode).toBe(201);
    expect(late.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls.create).toBe(2);
  });

  it("requires sign-in for a required key and skips users without a users row", async () => {
    const { calls } = setup();
    const anonymous = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { "idempotency-key": "k" },
      payload: { name: "a", targetCents: 1 },
    });
    expectProblem(anonymous, 401, "unauthorized");

    const preBootstrap = () =>
      app.inject({
        method: "POST",
        url: "/v1/notes",
        headers: { authorization: "Bearer subject:sub_new", "idempotency-key": "k" },
        payload: {},
      });
    await preBootstrap();
    await preBootstrap();
    expect(calls.create).toBe(2);
  });
});

describe("stored response size", () => {
  it("stores only status and headers above the cap, and says the body was omitted", async () => {
    const { calls } = setup();
    const first = await post("/v1/big", "key-big", {});
    expect(first.statusCode).toBe(201);
    expect(first.body.length).toBeGreaterThan(MAX_STORED_BODY_BYTES);
    const second = await post("/v1/big", "key-big", {});
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.headers["idempotent-body-omitted"]).toBe("true");
    expect(second.headers.location).toBe("/v1/big/1");
    expect(second.body).toBe("");
    expect(calls.create).toBe(1);
  });

  it("caps at 64 KiB", () => {
    expect(MAX_STORED_BODY_BYTES).toBe(64 * 1024);
  });
});

describe("explicit idempotency mode on writes", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s without config.idempotency fails at startup",
    async (method) => {
      const routes: FastifyPluginAsyncZod = async (scope) => {
        scope.route({ method, url: "/unset", handler: async () => ({}) });
      };
      app = testServer(routes);
      await expect(app.ready()).rejects.toThrow(/config\.idempotency/);
    },
  );

  it("reads need no mode", async () => {
    const routes: FastifyPluginAsyncZod = async (scope) => {
      scope.get("/ok", async () => ({}));
    };
    app = testServer(routes);
    await expect(app.ready()).resolves.toBeDefined();
  });
});

describe("request fingerprint", () => {
  it("canonicalJson sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe("");
  });

  it("covers method, URL and body", () => {
    const base = { method: "POST", url: "/v1/a", body: { x: 1 } };
    const hash = requestFingerprint(base);
    expect(requestFingerprint({ ...base })).toBe(hash);
    expect(requestFingerprint({ ...base, method: "PUT" })).not.toBe(hash);
    expect(requestFingerprint({ ...base, url: "/v1/b" })).not.toBe(hash);
    expect(requestFingerprint({ ...base, body: { x: 2 } })).not.toBe(hash);
  });
});
