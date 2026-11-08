// `pnpm dev:live` hands each process only the settings it needs (WP-32 security review): a dependency running in
// the web dev server must never see database passwords, and the one-time admin URL is never passed on.
import { describe, expect, it } from "vitest";
import { envFor, missingKeys } from "../dev-live-env.mjs";

const parent = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  npm_config_user_agent: "pnpm/9",
  SUPABASE_ADMIN_URL: "postgresql://postgres:admin@db/postgres",
  MIGRATOR_DATABASE_URL: "postgresql://mp_migrator:m@db/postgres",
  DATABASE_URL: "postgresql://mp_api:a@db/postgres",
  WORKER_DATABASE_URL: "postgresql://mp_worker:w@db/postgres",
  PGBOSS_DATABASE_URL: "postgresql://mp_queue:q@db/postgres",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  SUPABASE_SECRET_KEY: "sb-secret",
  TOKEN_MASTER_KEY: "k",
  ANTHROPIC_API_KEY: "sk-ant",
  NEXT_PUBLIC_API_URL: "http://localhost:4000",
  NEXT_PUBLIC_STORAGE_URL: "http://localhost:9000",
  NEXT_PUBLIC_MP_MOCK: "1",
  WEB_PORT: "3200",
  API_PORT: "4100",
  WEB_ORIGIN: "http://localhost:3200",
  SOME_UNRELATED_SECRET: "x",
};

describe("envFor", () => {
  it("web: only NEXT_PUBLIC_*, NODE_ENV, ports and the basics for running a process", () => {
    const env = envFor("web", parent);
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "LOG_LEVEL",
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_STORAGE_URL",
        "NODE_ENV",
        "PATH",
        "WEB_PORT",
        "npm_config_user_agent",
      ].sort(),
    );
  });

  it("never passes mock mode, whatever the shell says", () => {
    for (const name of ["web", "api", "worker"] as const) {
      expect(envFor(name, parent)).not.toHaveProperty("NEXT_PUBLIC_MP_MOCK");
    }
  });

  it("api: its database role, storage, mail, and no other role's URL", () => {
    const env = envFor("api", parent);
    expect(env.DATABASE_URL).toBe(parent.DATABASE_URL);
    expect(env.S3_SECRET_ACCESS_KEY).toBe("secret");
    expect(env.S3_PUBLIC_ENDPOINT).toBeDefined();
    expect(env.API_PORT).toBe("4100");
    for (const key of [
      "WORKER_DATABASE_URL",
      "PGBOSS_DATABASE_URL",
      "MIGRATOR_DATABASE_URL",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it("worker: its role and the queue role, never the migrator or the API's role", () => {
    const env = envFor("worker", parent);
    expect(env.WORKER_DATABASE_URL).toBe(parent.WORKER_DATABASE_URL);
    expect(env.PGBOSS_DATABASE_URL).toBe(parent.PGBOSS_DATABASE_URL);
    expect(env.TOKEN_MASTER_KEY).toBe("k");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    for (const key of [
      "MIGRATOR_DATABASE_URL",
      "DATABASE_URL",
      "SUPABASE_SECRET_KEY",
      "S3_PUBLIC_ENDPOINT",
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it("nobody gets the admin URL or unrelated variables", () => {
    for (const name of ["web", "api", "worker"] as const) {
      const env = envFor(name, parent);
      expect(env).not.toHaveProperty("SUPABASE_ADMIN_URL");
      expect(env).not.toHaveProperty("SOME_UNRELATED_SECRET");
    }
  });

  it("web never sees a secret, even one with a NEXT_PUBLIC-looking prefix elsewhere", () => {
    const env = envFor("web", { ...parent, DATABASE_URL_NEXT_PUBLIC: "x" });
    expect(JSON.stringify(env)).not.toMatch(/mp_api|mp_worker|secret|sk-ant/);
  });
});

describe("missingKeys", () => {
  it("names what a process needs and the shell lacks", () => {
    expect(missingKeys({})).toEqual([
      "DATABASE_URL",
      "WORKER_DATABASE_URL",
      "PGBOSS_DATABASE_URL",
      "NEXT_PUBLIC_API_URL",
    ]);
    expect(
      missingKeys({
        DATABASE_URL: "a",
        WORKER_DATABASE_URL: "b",
        PGBOSS_DATABASE_URL: "c",
        NEXT_PUBLIC_API_URL: "d",
      }),
    ).toEqual([]);
  });
});
