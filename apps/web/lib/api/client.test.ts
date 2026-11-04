// The bearer token goes only to the API's own origin, and redirects are never followed (L3).
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorized, getJson } from "./client";

const API = "https://api.moneypilot.example";
const token = async () => "secret-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(async (_input: Request, _init?: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("authorized fetch", () => {
  it("adds the bearer token for requests to the API origin", async () => {
    const fetchMock = stubFetch();
    await authorized(new Request(`${API}/v1/me`), token, API);
    const sent = fetchMock.mock.calls[0]?.[0];
    expect(sent?.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("does not send the token anywhere else, not even another port, scheme or subdomain", async () => {
    const fetchMock = stubFetch();
    for (const url of [
      "https://evil.example/v1/me",
      "https://api.moneypilot.example:8443/v1/me",
      "http://api.moneypilot.example/v1/me",
      "https://api.moneypilot.example.evil.example/v1/me",
    ]) {
      await authorized(new Request(url), token, API);
    }
    for (const call of fetchMock.mock.calls) expect(call[0].headers.get("authorization")).toBeNull();
  });

  it("refuses to follow redirects", async () => {
    const fetchMock = stubFetch();
    await authorized(new Request(`${API}/v1/me`), token, API);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("getJson uses the same rules and turns problem+json into an ApiError", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "plan_not_ready", detail: "Finish setup first." }), {
          status: 409,
          headers: { "content-type": "application/problem+json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getJson("/v1/households/h/plan", token, {}, API)).rejects.toMatchObject({
      status: 409,
      code: "plan_not_ready",
    });
    const sent = (fetchMock.mock.calls[0] as unknown as [Request, RequestInit])[0];
    expect(sent.headers.get("authorization")).toBe("Bearer secret-token");
    expect(sent.redirect).toBe("error");
  });
});
