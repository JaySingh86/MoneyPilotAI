import { describe, expect, expectTypeOf, it } from "vitest";
import type { Problem } from "../errors";
import { createApiClient } from "./index";

function stubFetch(status: number, body: unknown, contentType: string): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

describe("generated API client", () => {
  it("types and returns success bodies", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: stubFetch(200, { status: "ok" }, "application/json"),
    });
    const { data, error } = await client.GET("/health");
    expect(error).toBeUndefined();
    expect(data).toEqual({ status: "ok" });
    expectTypeOf(data).toEqualTypeOf<{ status: "ok" } | undefined>();
  });

  it("returns problem+json errors typed as Problem", async () => {
    const problem: Problem = {
      type: "/problems/rate_limited",
      title: "Too many requests",
      status: 429,
      code: "rate_limited",
    };
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: stubFetch(429, problem, "application/problem+json"),
    });
    const { data, error } = await client.GET("/health");
    expect(data).toBeUndefined();
    expect(error).toEqual(problem);
    expectTypeOf(error).toMatchTypeOf<{ code: Problem["code"] } | undefined>();
  });
});
