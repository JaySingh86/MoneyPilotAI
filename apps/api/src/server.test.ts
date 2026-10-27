import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("api skeleton", () => {
  it("answers health checks", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
