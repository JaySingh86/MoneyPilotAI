import { describe, expect, it } from "vitest";
import { StartupCheckError, assertQueueRole, resolveBossUrl } from "./startup-checks";

describe("pg-boss connection (security M2)", () => {
  it("production requires PGBOSS_DATABASE_URL, even when a migrator URL is present", () => {
    const env = { NODE_ENV: "production", MIGRATOR_DATABASE_URL: "postgres://mp_migrator@x/db" };
    expect(() => resolveBossUrl(env)).toThrow(StartupCheckError);
    expect(resolveBossUrl({ ...env, PGBOSS_DATABASE_URL: "postgres://mp_queue@x/db" })).toBe(
      "postgres://mp_queue@x/db",
    );
  });

  it("outside production it falls back to the migrator URL, and needs one of the two", () => {
    expect(resolveBossUrl({ NODE_ENV: "development", MIGRATOR_DATABASE_URL: "postgres://m@x/db" })).toBe(
      "postgres://m@x/db",
    );
    expect(() => resolveBossUrl({ NODE_ENV: "development" })).toThrow(StartupCheckError);
  });

  it("refuses a superuser, a role that bypasses RLS and mp_migrator", () => {
    expect(() =>
      assertQueueRole({ rolname: "mp_queue", rolsuper: false, rolbypassrls: false }),
    ).not.toThrow();
    expect(() => assertQueueRole({ rolname: "postgres", rolsuper: true, rolbypassrls: true })).toThrow(
      /superuser/,
    );
    expect(() => assertQueueRole({ rolname: "mp_x", rolsuper: false, rolbypassrls: true })).toThrow(
      /row-level/,
    );
    expect(() => assertQueueRole({ rolname: "mp_migrator", rolsuper: false, rolbypassrls: false })).toThrow(
      /mp_migrator/,
    );
  });
});
