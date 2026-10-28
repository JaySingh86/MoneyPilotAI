import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HouseholdParams } from "@mp/contracts";
import { bearer, expectProblem, HOUSEHOLD_1, testServer, USER_A } from "../lib/testing";
import type { ApiServer } from "../server";
import { dbContext, requireUserId } from "./request-context";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

const routes: FastifyPluginAsyncZod = async (scope) => {
  scope.get("/households/:hid/plan", { schema: { params: HouseholdParams } }, async (request) => ({
    ctx: dbContext(request),
    requestId: request.ctx.requestId,
  }));
  scope.get("/me", async (request) => ({ userId: requireUserId(request) }));
  scope.get(
    "/households/:hid/loose",
    { schema: { params: z.object({ hid: z.string() }) } },
    async (request) => ({ householdId: request.ctx.householdId }),
  );
  scope.post("/me/bootstrap", { config: { idempotency: "off" } }, async (request) => ({
    ctx: dbContext(request),
  }));
};

describe("request context", () => {
  it("carries the verified user and the household from the route", async () => {
    app = testServer(routes);
    const res = await app.inject({ url: `/v1/households/${HOUSEHOLD_1}/plan`, headers: bearer(USER_A) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ctx: { userId: USER_A, authSubject: `sub_${USER_A}`, householdId: HOUSEHOLD_1 },
      requestId: res.headers["x-request-id"],
    });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ignores a client-sent request id", async () => {
    app = testServer(routes);
    const res = await app.inject({ url: "/health", headers: { "x-request-id": "spoofed" } });
    expect(res.headers["x-request-id"]).not.toBe("spoofed");
  });

  it("requires a signed-in user", async () => {
    app = testServer(routes);
    expectProblem(await app.inject({ url: `/v1/households/${HOUSEHOLD_1}/plan` }), 401, "unauthorized");
    expectProblem(await app.inject({ url: "/v1/me" }), 401, "unauthorized");
  });

  it("rejects an invalid token", async () => {
    app = testServer(routes);
    expectProblem(
      await app.inject({ url: "/v1/me", headers: { authorization: "Bearer x" } }),
      401,
      "unauthorized",
    );
  });

  it("supports users before bootstrap (no users row yet)", async () => {
    app = testServer(routes);
    const headers = { authorization: "Bearer subject:sub_new" };
    expectProblem(await app.inject({ url: "/v1/me", headers }), 403, "forbidden");
    const res = await app.inject({ method: "POST", url: "/v1/me/bootstrap", headers });
    expect(res.json()).toEqual({ ctx: { userId: null, authSubject: "sub_new", householdId: null } });
  });

  it("validates the household id", async () => {
    app = testServer(routes);
    const res = await app.inject({ url: "/v1/households/not-a-uuid/plan", headers: bearer(USER_A) });
    expectProblem(res, 400, "validation_failed");
  });

  it("validates hid as a UUID even when the route's own schema is looser", async () => {
    app = testServer(routes);
    const bad = await app.inject({ url: "/v1/households/not-a-uuid/loose", headers: bearer(USER_A) });
    const problem = expectProblem(bad, 400, "validation_failed");
    expect(problem.fields).toEqual([{ in: "params", path: "hid", message: expect.any(String) }]);
    const ok = await app.inject({ url: `/v1/households/${HOUSEHOLD_1}/loose`, headers: bearer(USER_A) });
    expect(ok.json()).toEqual({ householdId: HOUSEHOLD_1 });
  });

  it("refuses a :hid route without a params schema at startup", async () => {
    const unsafe: FastifyPluginAsyncZod = async (scope) => {
      scope.get("/households/:hid/raw", async () => ({}));
    };
    app = testServer(unsafe);
    await expect(app.ready()).rejects.toThrow(/:hid.*params schema/);
  });
});
