import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { expectWebhookRejected as rejects, testServer } from "../testing";
import type { ApiServer } from "../../server";
import { assertGraphClientState, graphValidationResponse } from "./graph";

describe("Microsoft Graph clientState", () => {
  it("accepts notifications whose clientState all match", () => {
    expect(() =>
      assertGraphClientState({ value: [{ clientState: "s3cret" }, { clientState: "s3cret" }] }, "s3cret"),
    ).not.toThrow();
  });

  it("rejects a wrong, missing or partly wrong clientState and empty batches", async () => {
    await rejects(
      () => assertGraphClientState({ value: [{ clientState: "nope" }] }, "s3cret"),
      /clientState/,
    );
    await rejects(() => assertGraphClientState({ value: [{}] }, "s3cret"), /clientState/);
    await rejects(
      () => assertGraphClientState({ value: [{ clientState: "s3cret" }, { clientState: "x" }] }, "s3cret"),
      /clientState/,
    );
    await rejects(() => assertGraphClientState({ value: [] }, "s3cret"), /no notifications/);
    await rejects(() => assertGraphClientState("garbage", "s3cret"), /no notifications/);
  });
});

describe("Microsoft Graph validation handshake", () => {
  let app: ApiServer;
  afterEach(async () => {
    await app?.close();
  });

  const routes: FastifyPluginAsyncZod = async (scope) => {
    scope.post("/graph", { config: { idempotency: "off", rateLimit: false } }, async (request, reply) => {
      if (graphValidationResponse(request, reply)) return reply;
      return { handled: true };
    });
  };

  it("echoes validationToken as text/plain", async () => {
    app = testServer(routes);
    const res = await app.inject({
      method: "POST",
      url: "/v1/graph?validationToken=Validation%3A%20Testing",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toBe("Validation: Testing");
  });

  it("passes through when there is no validationToken", async () => {
    app = testServer(routes);
    const res = await app.inject({ method: "POST", url: "/v1/graph", payload: { value: [] } });
    expect(res.json()).toEqual({ handled: true });
  });

  it("refuses an oversized token", async () => {
    app = testServer(routes);
    const res = await app.inject({ method: "POST", url: `/v1/graph?validationToken=${"a".repeat(2000)}` });
    expect(res.statusCode).toBe(400);
  });
});
