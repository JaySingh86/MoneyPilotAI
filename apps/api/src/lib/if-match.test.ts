import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { expectProblem, testServer } from "./testing";
import type { ApiServer } from "../server";
import { assertVersion, parseVersionTag, requireIfMatch, setVersionTag, versionTag } from "./if-match";

describe("parseVersionTag", () => {
  it.each([
    ["7", 7],
    ['"7"', 7],
    ['W/"7"', 7],
    [' "12" ', 12],
    ["0", null],
    ["-1", null],
    ["*", null],
    ['"7", "8"', null],
    ["abc", null],
    ["1.5", null],
    ["99999999999999999", null],
  ])("%s → %s", (value, expected) => {
    expect(parseVersionTag(value)).toBe(expected);
  });

  it("round-trips versionTag", () => {
    expect(parseVersionTag(versionTag(42))).toBe(42);
  });
});

describe("If-Match on PATCH (BACKEND_PLAN §8.1)", () => {
  let app: ApiServer;
  afterEach(async () => {
    await app?.close();
  });

  const resource = { id: "b-car", name: "Car payment", version: 8 };
  const routes: FastifyPluginAsyncZod = async (scope) => {
    scope.patch("/items/b-car", { config: { idempotency: "optional" } }, async (request, reply) => {
      const expected = requireIfMatch(request);
      assertVersion(expected, resource);
      const updated = { ...resource, version: resource.version + 1 };
      return setVersionTag(reply, updated.version).send(updated);
    });
  };

  it("updates when the version matches and returns the new ETag", async () => {
    app = testServer(routes);
    const res = await app.inject({ method: "PATCH", url: "/v1/items/b-car", headers: { "if-match": '"8"' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"9"');
  });

  it("a stale version returns 409 with the current resource", async () => {
    app = testServer(routes);
    const res = await app.inject({ method: "PATCH", url: "/v1/items/b-car", headers: { "if-match": "7" } });
    const problem = expectProblem(res, 409, "conflict");
    expect(problem.current).toEqual(resource);
  });

  it("a missing If-Match returns 428", async () => {
    app = testServer(routes);
    const res = await app.inject({ method: "PATCH", url: "/v1/items/b-car" });
    const problem = expectProblem(res, 428, "precondition_required");
    expect(problem.fields?.[0]?.path).toBe("If-Match");
  });

  it("a malformed If-Match returns 400", async () => {
    app = testServer(routes);
    const res = await app.inject({ method: "PATCH", url: "/v1/items/b-car", headers: { "if-match": "*" } });
    expectProblem(res, 400, "validation_failed");
  });
});
