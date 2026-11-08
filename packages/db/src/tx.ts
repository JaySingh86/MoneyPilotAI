// Every DB access in apps/api and apps/worker goes through these (CLAUDE.md, ADR-003).
// Each call is one transaction whose session variables are set with set_config(..., true), i.e.
// SET LOCAL: they vanish at commit or rollback, so a pooled connection never carries a previous
// request's identity. RLS policies read them through app_user_id() / app_household_id() /
// app_auth_subject().
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema";

export type DbSchema = typeof schema;
type Database = NodePgDatabase<DbSchema>;
/** The transaction handle given to callbacks. Do not open nested transactions with it. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class DbContextError extends Error {
  override readonly name = "DbContextError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUTH_SUBJECT = 255;

/** Request context for the API role. Built by the auth layer from a verified token, never from input. */
export interface ApiContext {
  /** users.id of the signed-in user; null only before the users row exists (bootstrap). */
  userId: string | null;
  /** Verified auth-provider subject. Lets bootstrap create/read the caller's own users row. */
  authSubject?: string | null;
  /** The household the request is about. Informational for mp_api: RLS uses membership, not this. */
  householdId?: string | null;
}

export interface DbOptions {
  connectionString: string;
  /** Pool size. */
  max?: number;
}

export interface ApiDb {
  withHouseholdTx<T>(ctx: ApiContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface WorkerDb {
  /** Runs fn as mp_worker with RLS scoped to exactly one household. */
  withJobTx<T>(householdId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Every household id, for schedulers that fan a nightly job out per household (Q-051). Calls the
   * SECURITY DEFINER `app_list_household_ids()`; ids only, nothing else is readable this way.
   */
  listHouseholdIds(): Promise<string[]>;
  /** Households with billing events to apply, or a plan out of step with an ended subscription (WP-25). */
  listBillingPendingHouseholds(): Promise<string[]>;
  /** Households with a notification ready to send (`app_list_households_with_due_notifications()`, WP-15). */
  listHouseholdIdsWithDueNotifications(): Promise<string[]>;
  close(): Promise<void>;
}

function checkUuid(value: string | null | undefined, field: string): string {
  if (value == null) return "";
  if (!UUID.test(value)) throw new DbContextError(`${field} must be a uuid`);
  return value.toLowerCase();
}

function checkAuthSubject(value: string | null | undefined): string {
  if (value == null) return "";
  if (value.length === 0 || value.length > MAX_AUTH_SUBJECT) {
    throw new DbContextError(`authSubject must be 1-${MAX_AUTH_SUBJECT} characters`);
  }
  return value;
}

export type AppRole = "mp_api" | "mp_worker";

/**
 * Allowlist: the pool must connect as exactly the expected app role, which must neither be a superuser
 * nor bypass RLS. A migrator, analytics or cross-role URL is refused before any query runs.
 */
export function assertConnectionRole(
  expected: AppRole,
  role: { rolname: string; rolsuper: boolean; rolbypassrls: boolean },
): void {
  if (role.rolname !== expected) {
    throw new DbContextError(`Connection role is ${role.rolname}; this pool only accepts ${expected}.`);
  }
  if (role.rolsuper || role.rolbypassrls) {
    throw new DbContextError(`Role ${role.rolname} bypasses row-level security; refusing to use it.`);
  }
}

interface Session {
  "app.user_id": string;
  "app.household_id": string;
  "app.auth_subject": string;
}

function createRunner(expected: AppRole, options: DbOptions) {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema });
  let roleChecked: Promise<void> | null = null;

  const checkRole = (): Promise<void> => {
    roleChecked ??= (async () => {
      const res = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      );
      const role = res.rows[0];
      if (!role) throw new DbContextError("Could not read the connection role.");
      assertConnectionRole(expected, role);
    })().catch((error: unknown) => {
      roleChecked = null;
      throw error;
    });
    return roleChecked;
  };

  async function run<T>(session: Session, fn: (tx: Tx) => Promise<T>): Promise<T> {
    await checkRole();
    return db.transaction(async (tx) => {
      const res = await tx.execute<{ role: string }>(sql`select
        set_config('app.user_id', ${session["app.user_id"]}, true),
        set_config('app.household_id', ${session["app.household_id"]}, true),
        set_config('app.auth_subject', ${session["app.auth_subject"]}, true),
        current_user as role`);
      // Re-checked per transaction (cheap: same round trip), in case a connection's role was changed.
      if (res.rows[0]?.role !== expected) {
        throw new DbContextError(
          `Connection role changed to ${String(res.rows[0]?.role)}; expected ${expected}.`,
        );
      }
      return fn(tx);
    });
  }

  return { run, close: () => pool.end() };
}

/** Pool for apps/api, connected as mp_api (DATABASE_URL). */
export function createApiDb(options: DbOptions): ApiDb {
  const runner = createRunner("mp_api", options);
  return {
    async withHouseholdTx(ctx, fn) {
      const session: Session = {
        "app.user_id": checkUuid(ctx.userId, "userId"),
        "app.household_id": checkUuid(ctx.householdId, "householdId"),
        "app.auth_subject": checkAuthSubject(ctx.authSubject),
      };
      return runner.run(session, fn);
    },
    close: runner.close,
  };
}

/** Pool for apps/worker, connected as mp_worker (WORKER_DATABASE_URL). */
export function createWorkerDb(options: DbOptions): WorkerDb {
  const runner = createRunner("mp_worker", options);
  return {
    async withJobTx(householdId, fn) {
      if (!householdId) throw new DbContextError("householdId is required for a job transaction");
      const session: Session = {
        "app.user_id": "",
        "app.household_id": checkUuid(householdId, "householdId"),
        "app.auth_subject": "",
      };
      return runner.run(session, fn);
    },
    async listHouseholdIds() {
      const none: Session = { "app.user_id": "", "app.household_id": "", "app.auth_subject": "" };
      const res = await runner.run(none, (tx) =>
        tx.execute<{ id: string }>(sql`select app_list_household_ids() as id`),
      );
      return res.rows.map((r) => r.id);
    },
    async listBillingPendingHouseholds() {
      const none: Session = { "app.user_id": "", "app.household_id": "", "app.auth_subject": "" };
      const res = await runner.run(none, (tx) =>
        tx.execute<{ id: string }>(sql`select app_billing_pending_households() as id`),
      );
      return res.rows.map((r) => r.id);
    },
    async listHouseholdIdsWithDueNotifications() {
      const none: Session = { "app.user_id": "", "app.household_id": "", "app.auth_subject": "" };
      const res = await runner.run(none, (tx) =>
        tx.execute<{ id: string }>(sql`select app_list_households_with_due_notifications() as id`),
      );
      return res.rows.map((r) => r.id);
    },
    close: runner.close,
  };
}
