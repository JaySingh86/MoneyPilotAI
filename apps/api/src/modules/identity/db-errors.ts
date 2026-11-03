// Postgres error helpers for the identity and households repos.

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

/** The driver error (carrying SQLSTATE) inside Drizzle's wrappers, if any. */
export function pgErrorOf(error: unknown): PgErrorLike | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return current as PgErrorLike;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = "23505";
export const INSUFFICIENT_PRIVILEGE = "42501";

/** True for a unique violation on the named constraint/index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pg = pgErrorOf(error);
  return pg?.code === UNIQUE_VIOLATION && pg.constraint === constraint;
}

/**
 * Drizzle's node-postgres driver returns timestamptz columns as strings (`2026-10-28 12:00:00.123+00`),
 * whatever the column type says. V8 parses that form, so every timestamp read goes through here.
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toDateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}
