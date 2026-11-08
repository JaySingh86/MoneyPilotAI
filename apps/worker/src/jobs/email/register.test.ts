// The connector's registration: the revoke job and the sweeps are always registered, with or without a provider
// (a disconnect must be finished whatever the settings), and the key and secret checks fail loudly at startup.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import type { WorkerDb } from "@mp/db";
import { loadEmailJobDeps, registerEmailJobs } from "./discover/register";

function stubBoss() {
  const queues: string[] = [];
  const workers: string[] = [];
  const schedules: string[] = [];
  const boss = {
    createQueue: async (name: string) => void queues.push(name),
    work: async (name: string) => void workers.push(name),
    schedule: async (name: string) => void schedules.push(name),
  } as unknown as PgBoss;
  return { boss, queues, workers, schedules };
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const base = { db: {} as WorkerDb, now: () => "2026-11-09T12:00:00Z", log: quiet };
const MASTER = randomBytes(32).toString("base64");

describe("registerEmailJobs", () => {
  it("registers the revoke handler and both sweeps even when no provider is configured", async () => {
    const s = stubBoss();
    await registerEmailJobs(s.boss, { ...base, env: { NODE_ENV: "development", TOKEN_MASTER_KEY: MASTER } });
    expect(s.workers).toEqual(expect.arrayContaining(["email.revoke", "email.sweep", "email.watch.sweep"]));
    expect(s.schedules).toEqual(expect.arrayContaining(["email.sweep", "email.watch.sweep"]));
    expect(s.queues).toEqual(
      expect.arrayContaining(["email.discover", "email.backfill", "email.watch.renew", "email.revoke"]),
    );
  });

  it("registers them even with no key either (the job keeps the token and retries)", async () => {
    const s = stubBoss();
    await registerEmailJobs(s.boss, { ...base, env: { NODE_ENV: "development" } });
    expect(s.workers).toContain("email.revoke");
  });
});

describe("loadEmailJobDeps", () => {
  const google = {
    GOOGLE_GMAIL_CLIENT_ID: "id",
    GOOGLE_GMAIL_CLIENT_SECRET: "secret",
    API_PUBLIC_URL: "http://localhost:4000",
  };

  it("never returns null: no provider means empty providers", () => {
    expect(loadEmailJobDeps({ NODE_ENV: "development" }).providers).toEqual({});
  });

  it("a configured provider needs the webhook secret and a usable key", () => {
    expect(() => loadEmailJobDeps({ NODE_ENV: "development", ...google, TOKEN_MASTER_KEY: MASTER })).toThrow(
      /EMAIL_WEBHOOK_SECRET/,
    );
    expect(() =>
      loadEmailJobDeps({ NODE_ENV: "development", ...google, EMAIL_WEBHOOK_SECRET: MASTER }),
    ).toThrow(/TOKEN_MASTER_KEY|KMS_TOKEN_KEY_ID/);
    const ok = loadEmailJobDeps({
      NODE_ENV: "development",
      ...google,
      EMAIL_WEBHOOK_SECRET: MASTER,
      TOKEN_MASTER_KEY: MASTER,
    });
    expect(Object.keys(ok.providers)).toEqual(["gmail"]);
  });

  it("refuses the local key outside development and test (S2)", () => {
    expect(() =>
      loadEmailJobDeps({
        NODE_ENV: "production",
        ...google,
        EMAIL_WEBHOOK_SECRET: MASTER,
        TOKEN_MASTER_KEY: MASTER,
      }),
    ).toThrow(/NODE_ENV is development or test/);
  });
});
