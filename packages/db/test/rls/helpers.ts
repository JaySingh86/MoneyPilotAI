import { sql, type SQL } from "drizzle-orm";
import { expect, inject } from "vitest";
import { createApiDb, createWorkerDb, type ApiDb, type Tx, type WorkerDb } from "../../src/tx";

export const INSUFFICIENT_PRIVILEGE = "42501";

export function openDbs(): { api: ApiDb; worker: WorkerDb } {
  return {
    api: createApiDb({ connectionString: inject("databaseUrl"), max: 4 }),
    worker: createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 4 }),
  };
}

/** The Postgres SQLSTATE of an error, looking through driver/ORM wrappers. */
export function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

/** Asserts the statement is refused: RLS WITH CHECK violation or missing privilege (both 42501). */
export async function expectDenied(run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the statement to be rejected").toBeDefined();
  expect(pgCode(caught), String(caught)).toBe(INSUFFICIENT_PRIVILEGE);
}

/** Asserts the statement fails with the given SQLSTATE. */
export async function expectRejected(run: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the statement to be rejected").toBeDefined();
  expect(pgCode(caught), String(caught)).toBe(code);
}

/** The Postgres error itself (the object carrying the SQLSTATE), looking through wrappers. */
function pgError(error: unknown): { code?: string; message?: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return current as { code?: string; message?: string; constraint?: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Asserts a SECURITY DEFINER function refused with its documented reason: SQLSTATE 42501 and message
 * `reason` exactly, never a raw constraint error (e.g. 23505 with an index name).
 */
export async function expectReason(run: () => Promise<unknown>, reason: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${reason}`).toBeDefined();
  const err = pgError(caught);
  expect({ code: err?.code, message: err?.message, constraint: err?.constraint }, String(caught)).toEqual({
    code: INSUFFICIENT_PRIVILEGE,
    message: reason,
    constraint: undefined,
  });
}

/** Asserts a write changed nothing: either refused (42501) or matched zero rows. */
export async function expectNoRowsAffected(run: () => Promise<{ rowCount: number | null }>): Promise<void> {
  try {
    const res = await run();
    expect(res.rowCount ?? 0).toBe(0);
  } catch (error) {
    expect(pgCode(error), String(error)).toBe(INSUFFICIENT_PRIVILEGE);
  }
}

export async function count(tx: Tx, query: SQL): Promise<number> {
  const res = await tx.execute<{ n: string | number }>(sql`select count(*) as n from (${query}) q`);
  return Number(res.rows[0]?.n ?? 0);
}
