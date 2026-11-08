import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { bearer, expectProblem, testServer, USER_A, USER_B } from "../lib/testing";
import type { ApiServer } from "../server";
import { RATE_LIMITS } from "./rate-limit";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

const routes: FastifyPluginAsyncZod = async (scope) => {
  scope.get("/plan", async () => ({ ok: true }));
  scope.post(
    "/invites",
    { config: { idempotency: "optional", rateLimitGroup: "authSensitive" } },
    async () => ({}),
  );
  scope.post(
    "/invites/accept",
    { config: { idempotency: "optional", rateLimitGroup: "authSensitive" } },
    async () => ({}),
  );
  scope.get("/calc-a", { config: { rateLimitGroup: "compute" } }, async () => ({}));
  scope.post("/calc-b", { config: { idempotency: "off", rateLimitGroup: "compute" } }, async () => ({}));
  scope.post(
    "/custom",
    { config: { idempotency: "optional", rateLimit: { max: 2, timeWindow: "1 minute" } } },
    async () => ({}),
  );
};

describe("rate limits (BACKEND_PLAN §8.1)", () => {
  it("platform presets match the spec; daily Ask/export caps live in their services (Q-031)", () => {
    expect(RATE_LIMITS).toEqual({
      overall: { max: 600, timeWindow: "1 minute" },
      authSensitive: { max: 20, timeWindow: "1 minute" },
      authCredentials: { max: 10, timeWindow: "1 minute" },
      authSession: { max: 30, timeWindow: "1 minute" },
      compute: { max: 60, timeWindow: "1 minute" },
      imports: { max: 10, timeWindow: "1 minute" },
    });
  });

  it("limits per user, not per IP", async () => {
    app = testServer(routes, { rateLimit: { max: 2 } });
    const get = (user: string) => app.inject({ url: "/v1/plan", headers: bearer(user) });
    expect((await get(USER_A)).statusCode).toBe(200);
    expect((await get(USER_A)).statusCode).toBe(200);
    const limited = await get(USER_A);
    expectProblem(limited, 429, "rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await get(USER_B)).statusCode).toBe(200);
  });

  it("limits anonymous callers per IP", async () => {
    app = testServer(routes, { rateLimit: { max: 1 } });
    expect((await app.inject({ url: "/v1/plan", remoteAddress: "10.0.0.1" })).statusCode).toBe(200);
    expectProblem(await app.inject({ url: "/v1/plan", remoteAddress: "10.0.0.1" }), 429, "rate_limited");
    expect((await app.inject({ url: "/v1/plan", remoteAddress: "10.0.0.2" })).statusCode).toBe(200);
  });

  it("auth-sensitive routes share one budget of 20 per minute per user", async () => {
    app = testServer(routes);
    const post = (url: string, user = USER_A) => app.inject({ method: "POST", url, headers: bearer(user) });
    for (let i = 0; i < 10; i += 1) {
      expect((await post("/v1/invites")).statusCode).toBe(200);
      expect((await post("/v1/invites/accept")).statusCode).toBe(200);
    }
    expectProblem(await post("/v1/invites"), 429, "rate_limited");
    expectProblem(await post("/v1/invites/accept"), 429, "rate_limited");
    expect((await post("/v1/invites", USER_B)).statusCode).toBe(200);
  });

  it("compute routes (plan, what-if, calendar) share one budget of 60 per minute per user", async () => {
    app = testServer(routes);
    const a = (user = USER_A) => app.inject({ url: "/v1/calc-a", headers: bearer(user) });
    const b = (user = USER_A) => app.inject({ method: "POST", url: "/v1/calc-b", headers: bearer(user) });
    for (let i = 0; i < 30; i += 1) {
      expect((await a()).statusCode).toBe(200);
      expect((await b()).statusCode).toBe(200);
    }
    expectProblem(await a(), 429, "rate_limited");
    expectProblem(await b(), 429, "rate_limited");
    expect((await a(USER_B)).statusCode).toBe(200);
  });

  it("rejects an unknown rate-limit group at registration", async () => {
    const bad: FastifyPluginAsyncZod = async (scope) => {
      scope.get("/x", { config: { rateLimitGroup: "nope" as "authSensitive" } }, async () => ({}));
    };
    app = testServer(bad);
    await expect(app.ready()).rejects.toThrow(/Unknown rate-limit group: nope/);
  });

  it("still supports a one-off route limit", async () => {
    app = testServer(routes);
    const post = () => app.inject({ method: "POST", url: "/v1/custom", headers: bearer(USER_A) });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    expectProblem(await post(), 429, "rate_limited");
  });

  it("counts invalid tokens per IP before rejecting them", async () => {
    app = testServer(routes, { rateLimit: { max: 2 } });
    const bad = () => app.inject({ url: "/v1/plan", headers: { authorization: "Bearer guess" } });
    expectProblem(await bad(), 401, "unauthorized");
    expectProblem(await bad(), 401, "unauthorized");
    expectProblem(await bad(), 429, "rate_limited");
  });

  it("does not limit health checks", async () => {
    app = testServer(routes, { rateLimit: { max: 1 } });
    for (let i = 0; i < 3; i += 1) expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("limits the OpenAPI document like any other route", async () => {
    app = testServer(routes, { rateLimit: { max: 1 } });
    expect((await app.inject({ url: "/v1/openapi.json" })).statusCode).toBe(200);
    expectProblem(await app.inject({ url: "/v1/openapi.json" }), 429, "rate_limited");
  });
});
