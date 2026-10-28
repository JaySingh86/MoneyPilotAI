import type { InjectOptions } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, type ErrorCode } from "@mp/contracts";
import { assertVersion, requireIfMatch } from "../lib/if-match";
import { bearer, captureLogger, expectProblem, testServer, USER_A } from "../lib/testing";
import type { ApiServer } from "../server";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

const routes: FastifyPluginAsyncZod = async (scope) => {
  scope.post(
    "/things",
    {
      schema: {
        body: z.object({ name: z.string(), amountCents: z.number().int() }),
        querystring: z.object({ dryRun: z.enum(["true", "false"]).optional() }),
        response: { 201: z.object({ ok: z.boolean() }) },
      },
      config: { idempotency: "required" },
    },
    async (_req, reply) => reply.code(201).send({ ok: true }),
  );
  scope.get("/things/:id", { schema: { params: z.object({ id: z.uuid() }) } }, async () => ({ ok: true }));
  scope.get("/app-error", async () => {
    throw new AppError("entitlement_required", 403, "Ask needs MoneyPilot Plus.", {
      headers: { "x-upgrade": "plus" },
    });
  });
  scope.get("/mfa", async () => {
    throw new AppError("mfa_required", 403, "Confirm it's you to continue.");
  });
  scope.get("/forbidden", async () => {
    throw new AppError("forbidden");
  });
  scope.get("/crash", async () => {
    throw new Error("boom for sam@example.com");
  });
  scope.get("/bad-response", { schema: { response: { 200: z.object({ n: z.number() }) } } }, async () => {
    return { n: "not a number" } as unknown as { n: number };
  });
  scope.patch("/versioned", { config: { idempotency: "optional" } }, async (request) => {
    assertVersion(requireIfMatch(request), { id: "x", version: 8 });
    return { ok: true };
  });
  scope.get("/limited", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async () => ({}));
};

type Case = {
  name: string;
  status: number;
  code: ErrorCode;
  request: InjectOptions;
  /** Requests sent first (e.g. to exhaust a limit or store a key). */
  before?: InjectOptions[];
};

const auth = bearer(USER_A);
const json = { ...auth, "content-type": "application/json" };

const CASES: Case[] = [
  {
    name: "invalid body",
    status: 400,
    code: "validation_failed",
    request: {
      method: "POST",
      url: "/v1/things",
      headers: { ...json, "idempotency-key": "k1" },
      payload: { name: 1 },
    },
  },
  {
    name: "invalid querystring",
    status: 400,
    code: "validation_failed",
    request: {
      method: "POST",
      url: "/v1/things?dryRun=maybe",
      headers: { ...json, "idempotency-key": "k1" },
      payload: { name: "a", amountCents: 1 },
    },
  },
  {
    name: "invalid params",
    status: 400,
    code: "validation_failed",
    request: { method: "GET", url: "/v1/things/not-a-uuid", headers: auth },
  },
  {
    name: "malformed JSON",
    status: 400,
    code: "validation_failed",
    request: { method: "POST", url: "/v1/things", headers: json, payload: "{not json" },
  },
  {
    name: "missing Idempotency-Key",
    status: 400,
    code: "validation_failed",
    request: { method: "POST", url: "/v1/things", headers: json, payload: { name: "a", amountCents: 1 } },
  },
  {
    name: "invalid token",
    status: 401,
    code: "unauthorized",
    request: { method: "GET", url: "/v1/things/x", headers: { authorization: "Bearer nope" } },
  },
  { name: "AppError forbidden", status: 403, code: "forbidden", request: { url: "/v1/forbidden" } },
  {
    name: "AppError entitlement_required",
    status: 403,
    code: "entitlement_required",
    request: { url: "/v1/app-error" },
  },
  { name: "AppError mfa_required", status: 403, code: "mfa_required", request: { url: "/v1/mfa" } },
  { name: "unknown route", status: 404, code: "not_found", request: { url: "/v1/nope?code=abc" } },
  {
    name: "stale If-Match",
    status: 409,
    code: "conflict",
    request: { method: "PATCH", url: "/v1/versioned", headers: { "if-match": '"7"' } },
  },
  {
    name: "payload too large",
    status: 413,
    code: "payload_too_large",
    request: {
      method: "POST",
      url: "/v1/things",
      headers: json,
      payload: JSON.stringify({ name: "x".repeat(2048), amountCents: 1 }),
    },
  },
  {
    name: "unsupported media type",
    status: 415,
    code: "unsupported_media_type",
    request: {
      method: "POST",
      url: "/v1/things",
      headers: { ...auth, "content-type": "application/xml" },
      payload: "<a/>",
    },
  },
  {
    name: "Idempotency-Key reused with a different body",
    status: 422,
    code: "idempotency_key_reused",
    before: [
      {
        method: "POST",
        url: "/v1/things",
        headers: { ...json, "idempotency-key": "k2" },
        payload: { name: "a", amountCents: 1 },
      },
    ],
    request: {
      method: "POST",
      url: "/v1/things",
      headers: { ...json, "idempotency-key": "k2" },
      payload: { name: "b", amountCents: 1 },
    },
  },
  {
    name: "missing If-Match",
    status: 428,
    code: "precondition_required",
    request: { method: "PATCH", url: "/v1/versioned" },
  },
  {
    name: "rate limited",
    status: 429,
    code: "rate_limited",
    before: [{ url: "/v1/limited" }],
    request: { url: "/v1/limited" },
  },
  { name: "unexpected error", status: 500, code: "internal_error", request: { url: "/v1/crash" } },
  {
    name: "response schema violation",
    status: 500,
    code: "internal_error",
    request: { url: "/v1/bad-response" },
  },
];

describe("every error path returns RFC 9457 problem+json with a code (WP-08 acceptance)", () => {
  it.each(CASES)("$name → $status $code", async ({ request, before, status, code }) => {
    app = testServer(routes, { bodyLimit: 1024 });
    for (const r of before ?? []) await app.inject(r);
    const res = await app.inject(request);
    const problem = expectProblem(res, status, code);
    expect(problem.type).toBe(`/problems/${code}`);
    expect(problem.title.length).toBeGreaterThan(0);
    expect(problem.requestId).toBe(res.headers["x-request-id"]);
    expect(problem.instance).not.toContain("?");
  });
});

describe("problem details", () => {
  it("lists invalid fields with where they were sent", async () => {
    app = testServer(routes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/things",
      headers: { ...json, "idempotency-key": "k1" },
      payload: { name: 1 },
    });
    const problem = expectProblem(res, 400, "validation_failed");
    expect(problem.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "body", path: "name" }),
        expect.objectContaining({ in: "body", path: "amountCents" }),
      ]),
    );
  });

  it("keeps AppError detail and headers", async () => {
    app = testServer(routes);
    const res = await app.inject({ url: "/v1/app-error" });
    const problem = expectProblem(res, 403, "entitlement_required");
    expect(problem.detail).toBe("Ask needs MoneyPilot Plus.");
    expect(res.headers["x-upgrade"]).toBe("plus");
  });

  it("sends Retry-After when rate limited", async () => {
    app = testServer(routes);
    await app.inject({ url: "/v1/limited" });
    const res = await app.inject({ url: "/v1/limited" });
    expectProblem(res, 429, "rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("hides unexpected error messages from the client and the log", async () => {
    const { logger, text } = captureLogger();
    app = testServer(routes, { logger });
    const res = await app.inject({ url: "/v1/crash" });
    const problem = expectProblem(res, 500, "internal_error");
    expect(res.body).not.toContain("sam@example.com");
    expect(problem.detail).not.toContain("boom");
    expect(text()).toContain("request failed");
    expect(text()).not.toContain("sam@example.com");
  });

  it("strips the query string from instance", async () => {
    app = testServer(routes);
    const res = await app.inject({ url: "/v1/nope?code=oauth-secret&state=s1" });
    const problem = expectProblem(res, 404, "not_found");
    expect(problem.instance).toBe("/v1/nope");
    expect(res.body).not.toContain("oauth-secret");
  });
});
