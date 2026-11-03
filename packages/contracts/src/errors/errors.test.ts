import { describe, expect, it } from "vitest";
import { AppError, DEFAULT_STATUS, ERROR_CODES, isAppError, ProblemSchema, TITLES } from "./index";

describe("error codes (BACKEND_PLAN §8.1)", () => {
  it("includes every code the spec lists", () => {
    for (const code of [
      "validation_failed",
      "not_found",
      "forbidden",
      "conflict",
      "entitlement_required",
      "mfa_required",
      "rate_limited",
      "approval_required",
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it("has a 4xx/5xx status and a title for every code", () => {
    for (const code of ERROR_CODES) {
      expect(DEFAULT_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(DEFAULT_STATUS[code]).toBeLessThan(600);
      expect(TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe("AppError", () => {
  it("defaults the status from the code and exposes its detail to the logger", () => {
    const err = new AppError("not_found", undefined, "Item not found.");
    expect(err.status).toBe(404);
    expect(err.expose).toBe(true);
    expect(err.message).toBe("Item not found.");
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });

  it("keeps an explicit status", () => {
    expect(new AppError("conflict", 409).status).toBe(409);
    expect(new AppError("forbidden", 451).status).toBe(451);
  });

  it("rejects a non-error status", () => {
    expect(() => new AppError("conflict", 200)).toThrow(RangeError);
  });

  it("renders an RFC 9457 problem that matches the Problem schema", () => {
    const err = new AppError("conflict", 409, "Version mismatch.", { current: { id: "a", version: 8 } });
    const problem = err.toProblem({ instance: "/v1/x", requestId: "r-1" });
    expect(problem).toEqual({
      type: "/problems/conflict",
      title: "Conflict",
      status: 409,
      detail: "Version mismatch.",
      instance: "/v1/x",
      code: "conflict",
      requestId: "r-1",
      current: { id: "a", version: 8 },
    });
    expect(ProblemSchema.parse(problem)).toEqual(problem);
  });

  it("carries field errors and headers", () => {
    const err = new AppError("validation_failed", 400, "Invalid body.", {
      fields: [{ in: "body", path: "amountCents", message: "Expected integer" }],
      headers: { "retry-after": "5" },
    });
    expect(err.toProblem().fields).toHaveLength(1);
    expect(err.headers).toEqual({ "retry-after": "5" });
  });
});
