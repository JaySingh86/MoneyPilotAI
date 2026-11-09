// Registration of the processing pipeline: it exists only with an Anthropic client, and every queue has the settings
// BACKEND_PLAN §9 lists (5 attempts for email.process, singleton keys, a minute sweep).
import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import type { AiClient } from "@mp/ai";
import type { WorkerDb } from "@mp/db";
import {
  AI_BATCH_COLLECT_QUEUE,
  AI_BATCH_SUBMIT_QUEUE,
  aiBatchCollectSingletonKey,
  aiBatchSubmitSingletonKey,
} from "../../ai/batch";
import type { EmailJobDeps } from "../discover/connection";
import { EMAIL_PROCESS_QUEUE, EMAIL_PROCESS_QUEUE_OPTIONS, emailProcessSingletonKey } from "./process";
import { registerEmailProcessJobs } from "./register";
import { EMAIL_PROCESS_SWEEP_CRON, EMAIL_PROCESS_SWEEP_QUEUE } from "./sweep";

function stubBoss() {
  const queues = new Map<string, unknown>();
  const workers: string[] = [];
  const schedules: [string, string][] = [];
  const boss = {
    createQueue: async (name: string, options: unknown) => void queues.set(name, options),
    work: async (name: string) => void workers.push(name),
    schedule: async (name: string, cron: string) => void schedules.push([name, cron]),
  } as unknown as PgBoss;
  return { boss, queues, workers, schedules };
}

const warnings: string[] = [];
const log = {
  info: () => {},
  warn: (_o: unknown, m?: string) => void warnings.push(String(m ?? _o)),
  error: () => {},
};
const deps = { db: {} as WorkerDb, now: () => "2026-11-09T12:00:00Z", log };
const jobDeps = { db: deps.db, now: deps.now, log } as unknown as EmailJobDeps;

describe("registerEmailProcessJobs", () => {
  it("does not start anything without an Anthropic client, and says so", async () => {
    const s = stubBoss();
    await registerEmailProcessJobs(s.boss, deps, jobDeps, null);
    expect(s.workers).toEqual([]);
    expect(s.schedules).toEqual([]);
    expect(warnings.join(" ")).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("with a client it creates the queues, the workers and the minute sweep", async () => {
    const s = stubBoss();
    await registerEmailProcessJobs(s.boss, deps, jobDeps, {} as AiClient);
    expect([...s.queues.keys()].sort()).toEqual(
      [EMAIL_PROCESS_QUEUE, AI_BATCH_SUBMIT_QUEUE, AI_BATCH_COLLECT_QUEUE, EMAIL_PROCESS_SWEEP_QUEUE].sort(),
    );
    expect(s.workers.sort()).toEqual(
      [EMAIL_PROCESS_QUEUE, AI_BATCH_SUBMIT_QUEUE, AI_BATCH_COLLECT_QUEUE, EMAIL_PROCESS_SWEEP_QUEUE].sort(),
    );
    expect(s.schedules).toEqual([[EMAIL_PROCESS_SWEEP_QUEUE, EMAIL_PROCESS_SWEEP_CRON]]);
  });

  it("email.process retries 5 times and keeps one job per connection; batch jobs are per connection and per batch", () => {
    expect(EMAIL_PROCESS_QUEUE_OPTIONS).toMatchObject({ policy: "short", retryLimit: 5 });
    const ids = { householdId: "h", connectionId: "c" };
    expect(emailProcessSingletonKey(ids)).toBe("email.process:c");
    expect(aiBatchSubmitSingletonKey(ids)).toBe("ai.batch.submit:c");
    expect(aiBatchCollectSingletonKey({ householdId: "h", batchId: "msgbatch_1" })).toBe(
      "ai.batch.collect:msgbatch_1",
    );
  });
});
