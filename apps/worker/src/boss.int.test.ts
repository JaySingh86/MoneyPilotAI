// Real pg-boss against a real Postgres: the queues and the 02:00 UTC schedule are registered, the nightly
// sweep fans out with app_list_household_ids(), and plan.recompute is a debounced singleton that stores
// the fixture's calc snapshot.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "@mp/db";
import { createHousehold, ensureUser, seedFixture, seedPlanning, type SeedResult } from "@mp/db/testing";
import { createLogger } from "@mp/observability";
import { FakeEmailSender } from "@mp/notify/testing";
import { createFixtures, type Fixtures } from "./testing/notify-fixtures";
import { startJobs, type StartedJobs } from "./boss";
import { assertQueueRole, checkBossConnection, readConnectionRole } from "./startup-checks";
import { OCCURRENCES_SWEEP_CRON, OCCURRENCES_SWEEP_QUEUE } from "./jobs/occurrences/sweep";
import { PLAN_RECOMPUTE_QUEUE, enqueuePlanRecompute } from "./jobs/plan/recompute";

let api: ApiDb;
let worker: WorkerDb;
let admin: pg.Client;
let jobs: StartedJobs;
let seeded: SeedResult;
let secondHousehold: string;
let expectedSafeToSpend: number;
let fixtures: Fixtures;
const email = new FakeEmailSender();

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await admin.query(sql, params)).rows[0]?.n ?? 0);

beforeAll(async () => {
  api = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 2 });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 4 });
  admin = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  await admin.connect();
  const fixtureJson = await readFile(
    fileURLToPath(new URL("../../../design/fixtures/rivera-household.json", import.meta.url)),
    "utf8",
  );
  const fixture = JSON.parse(fixtureJson) as { expected: { safeToSpendCents: number } };
  expectedSafeToSpend = fixture.expected.safeToSpendCents;
  seeded = await seedFixture({ api, worker }, fixture);
  await seedPlanning({ api, worker }, seeded, fixture);
  const owner = await ensureUser(api, {
    authSubject: "sweep|second",
    email: "second@example.test",
    firstName: "Second",
    timezone: "America/Chicago",
  });
  secondHousehold = "00000000-0000-4000-8000-0000000000c3";
  await createHousehold(api, owner, {
    id: secondHousehold,
    name: "Second household",
    timezone: "America/Chicago",
    forwardingToken: "second-sweep",
  });
  // pg-boss creates its own schema, which mp_worker cannot: it connects as the superuser here.
  jobs = await startJobs({
    bossUrl: inject("adminDatabaseUrl"),
    db: worker,
    now: () => "2026-10-27T16:00:00Z",
    log: createLogger("worker", "silent"),
    pollingIntervalSeconds: 0.5,
    email,
    appUrl: "https://app.example.test",
  });
  fixtures = await createFixtures();
}, 240_000);

afterAll(async () => {
  await jobs?.stop();
  await fixtures?.close();
  await admin?.end();
  await api?.close();
  await worker?.close();
});

describe("queue connection role (security M2)", () => {
  it("accepts mp_worker and refuses a superuser connection", async () => {
    const worker = await readConnectionRole(inject("workerDatabaseUrl"));
    expect(worker.rolname).toBe("mp_worker");
    expect(() => assertQueueRole(worker)).not.toThrow();
    const superuser = await readConnectionRole(inject("adminDatabaseUrl"));
    expect(() => assertQueueRole(superuser)).toThrow(/superuser/);
  });

  it("checkBossConnection in production rejects the superuser URL and accepts a plain role", async () => {
    await expect(
      checkBossConnection({ NODE_ENV: "production", PGBOSS_DATABASE_URL: inject("adminDatabaseUrl") }),
    ).rejects.toThrow(/superuser/);
    await expect(
      checkBossConnection({ NODE_ENV: "production", PGBOSS_DATABASE_URL: inject("workerDatabaseUrl") }),
    ).resolves.toBe(inject("workerDatabaseUrl"));
    await expect(checkBossConnection({ NODE_ENV: "production" })).rejects.toThrow(/PGBOSS_DATABASE_URL/);
  });
});

describe("job registration", () => {
  it("creates the queues and schedules the nightly sweep at 02:00 UTC", async () => {
    for (const name of ["occurrences.materialize", PLAN_RECOMPUTE_QUEUE, OCCURRENCES_SWEEP_QUEUE]) {
      expect(await jobs.boss.getQueue(name), name).not.toBeNull();
    }
    const schedules = await jobs.boss.getSchedules(OCCURRENCES_SWEEP_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ name: OCCURRENCES_SWEEP_QUEUE, cron: OCCURRENCES_SWEEP_CRON });
  });

  it("registering twice (a restart) keeps one schedule", async () => {
    const again = await startJobs({
      bossUrl: inject("adminDatabaseUrl"),
      db: worker,
      now: () => "2026-10-27T16:00:00Z",
      log: createLogger("worker", "silent"),
      email,
      appUrl: "https://app.example.test",
    });
    try {
      expect(await again.boss.getSchedules(OCCURRENCES_SWEEP_QUEUE)).toHaveLength(1);
      for (const name of ["reminders.sweep", "notifications.sweep", "proposals.expire.sweep"]) {
        expect(await again.boss.getSchedules(name), name).toHaveLength(1);
      }
    } finally {
      await again.stop();
    }
  });
});

describe("occurrences.sweep", () => {
  it("lists every household through app_list_household_ids()", async () => {
    const ids = await worker.listHouseholdIds();
    expect(ids).toEqual(expect.arrayContaining([seeded.householdId, secondHousehold]));
  });

  it("fans out one materialize job per household, and each one completes", async () => {
    const before = await count(
      "select count(*)::int as n from pgboss.job where name = 'occurrences.materialize'",
      [],
    );
    await jobs.boss.send(OCCURRENCES_SWEEP_QUEUE, {});
    await until(
      async () =>
        (await count(
          "select count(*)::int as n from pgboss.job where name = 'occurrences.materialize'",
          [],
        )) >=
        before + 2,
      "the materialize jobs to be enqueued",
    );
    // Other test files add households to the same database, so wait for THIS test's two, not for any two.
    await until(
      async () =>
        (await count(
          "select count(distinct data->>'householdId')::int as n from pgboss.job where name = 'occurrences.materialize' and state = 'completed' and data->>'householdId' = any($1::text[])",
          [[seeded.householdId, secondHousehold]],
        )) >= 2,
      "the materialize jobs to complete",
    );
    for (const id of [seeded.householdId, secondHousehold]) {
      expect(
        await count(
          "select count(*)::int as n from pgboss.job where name = 'occurrences.materialize' and data->>'householdId' = $1 and state = 'completed'",
          [id],
        ),
      ).toBe(1);
    }
  });
});

describe("plan.recompute", () => {
  it("is a debounced singleton: a burst of writes queues one job", async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4, 5].map(() => enqueuePlanRecompute(jobs.boss, secondHousehold)),
    );
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(
      await count("select count(*)::int as n from pgboss.job where name = $1 and data->>'householdId' = $2", [
        PLAN_RECOMPUTE_QUEUE,
        secondHousehold,
      ]),
    ).toBe(1);
  });

  it("stores the fixture's snapshot, once, however often it runs", async () => {
    await enqueuePlanRecompute(jobs.boss, seeded.householdId);
    const snapshot = await until(async () => {
      const r = await admin.query(
        "select id, result->>'safeToSpendCents' as safe, result->>'asOf' as as_of from calc_snapshots where household_id = $1",
        [seeded.householdId],
      );
      return r.rows[0] as { id: string; safe: string; as_of: string } | undefined;
    }, "the snapshot");
    expect(snapshot.as_of).toBe("2026-10-27");
    expect(Number(snapshot.safe)).toBe(expectedSafeToSpend);

    // run it again after the debounce slot: same input, same row
    await new Promise((r) => setTimeout(r, 2500));
    await enqueuePlanRecompute(jobs.boss, seeded.householdId);
    await until(
      async () =>
        (await count(
          "select count(*)::int as n from pgboss.job where name = $1 and data->>'householdId' = $2 and state = 'completed'",
          [PLAN_RECOMPUTE_QUEUE, seeded.householdId],
        )) >= 2,
      "the second recompute",
    );
    expect(
      await count("select count(*)::int as n from calc_snapshots where household_id = $1", [
        seeded.householdId,
      ]),
    ).toBe(1);
  });

  it("skips a household that cannot be planned yet instead of failing", async () => {
    await enqueuePlanRecompute(jobs.boss, secondHousehold);
    await until(
      async () =>
        (await count(
          "select count(*)::int as n from pgboss.job where name = $1 and data->>'householdId' = $2 and state = 'completed'",
          [PLAN_RECOMPUTE_QUEUE, secondHousehold],
        )) >= 1,
      "the job to complete",
    );
    expect(
      await count("select count(*)::int as n from calc_snapshots where household_id = $1", [secondHousehold]),
    ).toBe(0);
  });
});

describe("WP-15 and WP-13 job registration", () => {
  it("creates the queues and the schedules: reminders every 15 min, dispatch every minute, proposals hourly", async () => {
    for (const name of [
      "reminders.sweep",
      "reminders.plan",
      "notifications.sweep",
      "notifications.dispatch",
      "proposals.expire.sweep",
      "proposals.expire",
      "tasks.auto_complete",
    ]) {
      expect(await jobs.boss.getQueue(name), name).not.toBeNull();
    }
    const cron = async (name: string) => (await jobs.boss.getSchedules(name))[0]?.cron;
    expect(await cron("reminders.sweep")).toBe("*/15 * * * *");
    expect(await cron("notifications.sweep")).toBe("* * * * *");
    expect(await cron("proposals.expire.sweep")).toBe("0 * * * *");
  });

  it("reminders.sweep fans out reminders.plan, which plans each household", async () => {
    const hh = await fixtures.household();
    await fixtures.bill(hh, { scheduledOn: "2026-11-06" });
    // The worker clock is 2026-10-27; the bill is 10 days out, so the 3-day and 0-day reminders are planned.
    await jobs.boss.send("reminders.sweep", {});
    await until(
      async () =>
        (await count(
          "select count(*)::int as n from notifications where household_id = $1 and kind = 'reminder'",
          [hh.id],
        )) === 2,
      "the reminders to be planned",
    );
    // a second sweep adds nothing
    await jobs.boss.send("reminders.sweep", {});
    await new Promise((r) => setTimeout(r, 2500));
    expect(
      await count(
        "select count(*)::int as n from notifications where household_id = $1 and kind = 'reminder'",
        [hh.id],
      ),
    ).toBe(2);
  });

  it("notifications.sweep fans out notifications.dispatch, which emails what is due", async () => {
    const hh = await fixtures.household();
    await fixtures.query(
      `insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
       values ($1, $2, 'proposal', $3, 'Sam asked you to approve a change', 'Open MoneyPilot.', '2026-10-27T15:00:00Z')`,
      [hh.id, hh.jordan.id, `boss:${hh.id}`],
    );
    await jobs.boss.send("notifications.sweep", {});
    await until(
      async () => email.sent.some((m) => m.to === hh.jordan.email),
      "the notification to be emailed",
    );
    expect(
      await count(
        "select count(*)::int as n from notifications where household_id = $1 and status = 'sent'",
        [hh.id],
      ),
    ).toBe(1);
  });

  it("proposals.expire runs for a household and expires its overdue proposal (Q-117)", async () => {
    const hh = await fixtures.household();
    const id = crypto.randomUUID();
    await fixtures.query(
      `insert into proposals (id, household_id, kind, payload, proposed_by, expires_at, created_at)
       values ($1, $2, 'goal_change', '{"type":"goal_delete"}'::jsonb, $3, '2026-10-26T00:00:00Z', '2026-10-19T00:00:00Z')`,
      [id, hh.id, hh.sam.id],
    );
    await jobs.boss.send("proposals.expire", { householdId: hh.id });
    await until(
      async () =>
        (await admin.query("select status from proposals where id = $1", [id])).rows[0]?.status === "expired",
      "the proposal to expire",
    );
  });

  it("tasks.auto_complete completes the task waiting for the event (Q-117)", async () => {
    const hh = await fixtures.household();
    const { itemId } = await fixtures.bill(hh, { scheduledOn: "2026-11-06" });
    const taskId = crypto.randomUUID();
    await fixtures.query(
      `insert into tasks (id, household_id, title, owner_type, source, auto_complete_rule)
       values ($1, $2, 'Check the amount', 'both', 'engine', $3::jsonb)`,
      [taskId, hh.id, JSON.stringify({ type: "item_reviewed", itemId })],
    );
    await jobs.boss.send("tasks.auto_complete", {
      householdId: hh.id,
      event: { type: "item_reviewed", itemId },
    });
    await until(
      async () =>
        (await admin.query("select completed_reason from tasks where id = $1", [taskId])).rows[0]
          ?.completed_reason === "item_reviewed",
      "the task to complete",
    );
  });

  it("a bad payload fails the job without leaking it", async () => {
    const id = await jobs.boss.send("proposals.expire", {
      householdId: "not-a-uuid",
      secret: "jordan@example.test",
    });
    await until(
      async () =>
        ["retry", "failed"].includes(
          (await admin.query("select state from pgboss.job where id = $1", [id])).rows[0]?.state as string,
        ),
      "the job to fail",
    );
    const out = JSON.stringify(
      (await admin.query("select output from pgboss.job where id = $1", [id])).rows[0],
    );
    expect(out).not.toContain("jordan@example.test");
    expect(out).not.toContain("not-a-uuid");
  });
});
