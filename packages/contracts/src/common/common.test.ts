import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Cents, IdempotencyKey, IsoDate, page, PaginationQuery, Timestamp, Uuid } from "./index";

describe("common wire primitives", () => {
  it("IsoDate accepts real calendar dates only", () => {
    expect(IsoDate.safeParse("2026-11-06").success).toBe(true);
    expect(IsoDate.safeParse("2028-02-29").success).toBe(true);
    expect(IsoDate.safeParse("2027-02-29").success).toBe(false);
    expect(IsoDate.safeParse("2026-13-01").success).toBe(false);
    expect(IsoDate.safeParse("2026-11-6").success).toBe(false);
    expect(IsoDate.safeParse("2026-11-06T00:00:00Z").success).toBe(false);
  });

  it("Cents is an integer (hard rule 1)", () => {
    expect(Cents.safeParse(100701).success).toBe(true);
    expect(Cents.safeParse(-38900).success).toBe(true);
    expect(Cents.safeParse(1007.01).success).toBe(false);
    expect(Cents.safeParse("100701").success).toBe(false);
  });

  it("Timestamp is ISO 8601 UTC", () => {
    expect(Timestamp.safeParse("2026-10-24T14:02:00Z").success).toBe(true);
    expect(Timestamp.safeParse("2026-10-24").success).toBe(false);
  });

  it("Uuid", () => {
    expect(Uuid.safeParse("0d9f0b3e-7c1a-4d1e-9b0a-1e2f3a4b5c6d").success).toBe(true);
    expect(Uuid.safeParse("m-sam").success).toBe(false);
  });

  it("PaginationQuery defaults and bounds the limit", () => {
    expect(PaginationQuery.parse({})).toEqual({ limit: 50 });
    expect(PaginationQuery.parse({ limit: "10", cursor: "abc" })).toEqual({ limit: 10, cursor: "abc" });
    expect(PaginationQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(PaginationQuery.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("page() wraps items with nextCursor", () => {
    const schema = page(z.object({ id: z.string() }));
    expect(schema.parse({ data: [{ id: "a" }], nextCursor: null })).toEqual({
      data: [{ id: "a" }],
      nextCursor: null,
    });
  });

  it("IdempotencyKey accepts visible ASCII up to 255 characters", () => {
    expect(IdempotencyKey.safeParse("4f1c2b9a-key").success).toBe(true);
    expect(IdempotencyKey.safeParse("").success).toBe(false);
    expect(IdempotencyKey.safeParse("has space").success).toBe(false);
    expect(IdempotencyKey.safeParse("x".repeat(256)).success).toBe(false);
  });
});
