import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule } from "./lib/module";
import { captureLogger, expectProblem, testServer } from "./lib/testing";
import { modules } from "./modules";
import { buildServer, type ApiServer } from "./server";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

const thingRoutes: FastifyPluginAsyncZod = async (scope) => {
  scope.get(
    "/things/:id",
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ id: z.string() }) },
      },
    },
    async (request) => ({ id: request.params.id }),
  );
  scope.get("/callback", async () => ({ ok: true }));
};

describe("api platform", () => {
  it("answers health checks", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("mounts modules under /v1 by default, or under their own prefix", async () => {
    app = buildServer({
      modules: [
        defineModule({ name: "things", routes: thingRoutes }),
        defineModule({
          name: "hooks",
          prefix: "/webhooks",
          routes: async (s) =>
            void s.post("/x", { config: { idempotency: "off", rateLimit: false } }, async () => ({})),
        }),
      ],
    });
    expect((await app.inject({ url: "/v1/things/abc" })).json()).toEqual({ id: "abc" });
    expect((await app.inject({ method: "POST", url: "/webhooks/x" })).statusCode).toBe(200);
    expectProblem(await app.inject({ url: "/things/abc" }), 404, "not_found");
  });

  it("refuses two modules with the same name", () => {
    const m = defineModule({ name: "items", routes: async () => {} });
    expect(() => buildServer({ modules: [m, m] })).toThrow(/Duplicate API module name: items/);
  });

  it("starts with an append-only registry of uniquely named modules", () => {
    expect(new Set(modules.map((m) => m.name)).size).toBe(modules.length);
  });

  it("logs each request with the route template only, never the raw path or query", async () => {
    const { logger, lines, text } = captureLogger();
    app = testServer(thingRoutes, { logger });
    await app.inject({ url: "/v1/callback?code=oauth-code-123&state=st-456" });
    await app.inject({ url: "/v1/things/tok_secret_789" });
    await app.inject({ url: "/v1/unknown/tok_secret_789" });
    const completed = lines().filter((l) => l.msg === "request completed");
    expect(completed).toHaveLength(3);
    expect(completed[0]).toMatchObject({
      service: "api",
      method: "GET",
      route: "/v1/callback",
      statusCode: 200,
    });
    expect(completed[1]).toMatchObject({ route: "/v1/things/:id", statusCode: 200 });
    expect(completed[2]).toMatchObject({ route: null, statusCode: 404 });
    for (const line of completed) {
      expect(line).not.toHaveProperty("url");
      expect(line.reqId).toBeTruthy();
    }
    expect(text()).not.toContain("oauth-code-123");
    expect(text()).not.toContain("st-456");
    expect(text()).not.toContain("tok_secret_789");
  });

  it("allows CORS from the configured web origin only", async () => {
    app = buildServer({ corsOrigins: ["http://localhost:3100"] });
    const preflight = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/health",
        headers: { origin, "access-control-request-method": "POST" },
      });
    const ok = await preflight("http://localhost:3100");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3100");
    expect(String(ok.headers["access-control-allow-headers"])).toContain("idempotency-key");
    const other = await preflight("https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("OpenAPI (ADR-008)", () => {
  it("serves an OpenAPI 3.1 document at /v1/openapi.json with problem responses", async () => {
    app = testServer(thingRoutes);
    const res = await app.inject({ url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.schemas.Problem.required).toEqual(["type", "title", "status", "code"]);
    const op = doc.paths["/v1/things/{id}"].get;
    expect(op.tags).toEqual(["test"]);
    expect(op.responses["4XX"].content["application/problem+json"].schema).toEqual({
      $ref: "#/components/schemas/Problem",
    });
    expect(doc.paths["/v1/openapi.json"]).toBeUndefined();
  });

  it("keeps webhook routes out of the public document", async () => {
    app = buildServer({
      modules: [
        defineModule({ name: "things", routes: thingRoutes }),
        defineModule({
          name: "webhooks",
          prefix: "/webhooks",
          routes: async (s) => {
            s.post(
              "/billing",
              {
                schema: { body: z.object({ type: z.string() }) },
                config: { idempotency: "off", rateLimit: false },
              },
              async () => ({}),
            );
            s.post("/ses", { config: { idempotency: "off", rateLimit: false } }, async () => ({}));
          },
        }),
      ],
    });
    const doc = (await app.inject({ url: "/v1/openapi.json" })).json();
    expect(Object.keys(doc.paths)).toEqual(["/health", "/v1/things/{id}", "/v1/callback"]);
  });

  it("matches the committed @mp/contracts document (client and server agree)", async () => {
    app = buildServer();
    const served = (await app.inject({ url: "/v1/openapi.json" })).json();
    const require = createRequire(import.meta.url);
    const committed = JSON.parse(readFileSync(require.resolve("@mp/contracts/openapi.json"), "utf8"));
    expect(served).toEqual(committed);
  });
});
