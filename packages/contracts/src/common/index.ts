// Shared wire primitives (BACKEND_PLAN §8.1). Every module's contracts build on these.
import { z } from "zod";

/** UUID (all ids). */
export const Uuid = z.uuid();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return d <= days;
}

/**
 * Calendar date `YYYY-MM-DD` in the household's timezone (hard rule 2). Stays a string on the wire;
 * the API converts it to a Temporal `PlainDate` at the boundary.
 */
export const IsoDate = z
  .string()
  .regex(ISO_DATE, { error: "Expected a date as YYYY-MM-DD", abort: true })
  .refine(isRealDate, "Not a real calendar date")
  .meta({ format: "date", description: "Calendar date YYYY-MM-DD (household timezone)" });

/** UTC instant, ISO 8601 with `Z` (e.g. `2026-10-24T14:02:00Z`). */
export const Timestamp = z.iso.datetime();

/** Money in integer cents (hard rule 1). Negative for outflows where a field says so. */
export const Cents = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).meta({
  description: "Integer cents",
});

/** Optimistic-concurrency version carried by every mutable resource (`If-Match`). */
export const Version = z.number().int().min(1);

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;

/** `?limit=50&cursor=…` (cursor-based pagination). */
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});

/** `{ data: [...], nextCursor }` page envelope. `nextCursor` is null on the last page. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

/** Path params for every `/households/:hid/...` route. */
export const HouseholdParams = z.object({ hid: Uuid });

/** `Idempotency-Key` value: 1–255 visible ASCII characters (a UUID is recommended). */
export const IdempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "Use visible ASCII characters only");

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IDEMPOTENT_REPLAYED_HEADER = "idempotent-replayed";
export const IF_MATCH_HEADER = "if-match";
export const REQUEST_ID_HEADER = "x-request-id";
