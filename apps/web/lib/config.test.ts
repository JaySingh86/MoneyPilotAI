import { describe, expect, it } from "vitest";
import { assertMockAllowed, resolveMockMode } from "./config";

describe("mock mode", () => {
  it("is on only when asked for, outside production", () => {
    expect(resolveMockMode("development", "1")).toBe(true);
    expect(resolveMockMode("test", "1")).toBe(true);
    expect(resolveMockMode("development", undefined)).toBe(false);
    expect(resolveMockMode("development", "0")).toBe(false);
  });

  it("can never be on in production, whatever the flag says", () => {
    expect(resolveMockMode("production", "1")).toBe(false);
    expect(resolveMockMode("production", "true")).toBe(false);
  });

  it("refuses to run a production environment that sets the flag", () => {
    expect(() => assertMockAllowed("production", "1")).toThrow(/not available in production/);
    expect(() => assertMockAllowed("production", "0")).toThrow();
    expect(() => assertMockAllowed("production", undefined)).not.toThrow();
    expect(() => assertMockAllowed("development", "1")).not.toThrow();
  });
});
