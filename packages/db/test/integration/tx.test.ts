import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assertConnectionRole,
  createApiDb,
  createWorkerDb,
  DbContextError,
  type ApiDb,
  type WorkerDb,
} from "../../src/tx";

const USER = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "22222222-2222-4222-8222-222222222222";

type Session = {
  role: string;
  user_id: string | null;
  household_id: string | null;
  auth_subject: string | null;
};
const readSession = sql`select current_user as role, app_user_id() as user_id,
  app_household_id() as household_id, app_auth_subject() as auth_subject`;

describe("withHouseholdTx (mp_api)", () => {
  let db: ApiDb;
  beforeAll(() => {
    // One connection, so leaks between transactions on the same pooled connection would show.
    db = createApiDb({ connectionString: inject("databaseUrl"), max: 1 });
  });
  afterAll(async () => {
    await db.close();
  });

  it("runs as mp_api with app.user_id, app.household_id and app.auth_subject set locally", async () => {
    const row = await db.withHouseholdTx(
      { userId: USER, householdId: HOUSEHOLD, authSubject: "user_abc" },
      async (tx) => (await tx.execute<Session>(readSession)).rows[0],
    );
    expect(row).toEqual({ role: "mp_api", user_id: USER, household_id: HOUSEHOLD, auth_subject: "user_abc" });
  });

  it("does not leak context to the next transaction on the same connection", async () => {
    await db.withHouseholdTx({ userId: USER, householdId: HOUSEHOLD }, async () => undefined);
    const row = await db.withHouseholdTx(
      { userId: null },
      async (tx) => (await tx.execute<Session>(readSession)).rows[0],
    );
    expect(row).toMatchObject({ user_id: null, household_id: null, auth_subject: null });
  });

  it("does not leak context after a rollback", async () => {
    await expect(
      db.withHouseholdTx({ userId: USER }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await db.withHouseholdTx(
      { userId: null },
      async (tx) => (await tx.execute<Session>(readSession)).rows[0],
    );
    expect(row?.user_id).toBeNull();
  });

  it("rolls back writes when fn throws", async () => {
    const subject = `rollback-${Date.now()}`;
    await expect(
      db.withHouseholdTx({ userId: null, authSubject: subject }, async (tx) => {
        await tx.execute(sql`insert into users (auth_subject, email, first_name)
          values (${subject}, ${`${subject}@example.test`}, 'Rollback')`);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const count = await db.withHouseholdTx({ userId: null, authSubject: subject }, async (tx) =>
      Number((await tx.execute<{ n: string }>(sql`select count(*) as n from users`)).rows[0]?.n),
    );
    expect(count).toBe(0);
  });

  it.each([
    [{ userId: "not-a-uuid" }],
    [{ userId: USER, householdId: "hh-rivera" }],
    [{ userId: null, authSubject: "" }],
    [{ userId: null, authSubject: "x".repeat(256) }],
  ])("rejects a malformed context %j before touching the database", async (ctx) => {
    await expect(db.withHouseholdTx(ctx, async () => undefined)).rejects.toBeInstanceOf(DbContextError);
  });
});

describe("withJobTx (mp_worker)", () => {
  let db: WorkerDb;
  beforeAll(() => {
    db = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 1 });
  });
  afterAll(async () => {
    await db.close();
  });

  it("runs as mp_worker scoped to one household, with no user", async () => {
    const row = await db.withJobTx(HOUSEHOLD, async (tx) => (await tx.execute<Session>(readSession)).rows[0]);
    expect(row).toEqual({ role: "mp_worker", user_id: null, household_id: HOUSEHOLD, auth_subject: null });
    const after = await db.withJobTx(USER, async (tx) => (await tx.execute<Session>(readSession)).rows[0]);
    expect(after?.household_id).toBe(USER);
  });

  it("rejects a household id that is not a uuid", async () => {
    await expect(db.withJobTx("hh-rivera", async () => undefined)).rejects.toBeInstanceOf(DbContextError);
  });
});

describe("assertConnectionRole (allowlist)", () => {
  it("accepts only the expected app role, and never a superuser or BYPASSRLS role", () => {
    const ok = { rolname: "mp_api", rolsuper: false, rolbypassrls: false };
    expect(() => assertConnectionRole("mp_api", ok)).not.toThrow();
    expect(() => assertConnectionRole("mp_worker", ok)).toThrow(DbContextError);
    expect(() => assertConnectionRole("mp_api", { ...ok, rolname: "mp_migrator" })).toThrow(DbContextError);
    expect(() => assertConnectionRole("mp_api", { ...ok, rolsuper: true })).toThrow(DbContextError);
    expect(() => assertConnectionRole("mp_api", { ...ok, rolbypassrls: true })).toThrow(DbContextError);
  });
});

describe("G1-3 pools refuse any connection role but their own", () => {
  it.each([
    ["workerDatabaseUrl", "mp_worker"],
    ["migratorDatabaseUrl", "mp_migrator"],
  ] as const)("createApiDb refuses %s (%s)", async (key, _role) => {
    const db = createApiDb({ connectionString: inject(key), max: 1 });
    try {
      await expect(db.withHouseholdTx({ userId: USER }, async () => "ran")).rejects.toBeInstanceOf(
        DbContextError,
      );
    } finally {
      await db.close();
    }
  });

  it.each([
    ["databaseUrl", "mp_api"],
    ["migratorDatabaseUrl", "mp_migrator"],
  ] as const)("createWorkerDb refuses %s (%s)", async (key, _role) => {
    const db = createWorkerDb({ connectionString: inject(key), max: 1 });
    try {
      await expect(db.withJobTx(HOUSEHOLD, async () => "ran")).rejects.toBeInstanceOf(DbContextError);
    } finally {
      await db.close();
    }
  });
});
