import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { fixtureUuid, planFixtureSeed, seedFixture } from "../../src/seed/rivera";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "../../src/tx";
import { FIXTURE_PATH, REPO_ROOT } from "../setup/paths";

const run = promisify(execFile);

describe("fixtureUuid", () => {
  it("is a deterministic RFC 4122 v5 uuid per fixture id", () => {
    expect(fixtureUuid("hh-rivera")).toBe(fixtureUuid("hh-rivera"));
    expect(fixtureUuid("m-sam")).not.toBe(fixtureUuid("m-jordan"));
    expect(fixtureUuid("m-sam")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("planFixtureSeed", () => {
  let fixture: unknown;
  beforeAll(async () => {
    fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  });

  it("maps the Rivera household and both members from the golden fixture", () => {
    const plan = planFixtureSeed(fixture);
    expect(plan.household).toMatchObject({
      id: fixtureUuid("hh-rivera"),
      name: "Rivera household",
      plan: "family_plus",
      cushionCents: 50000,
      forwardingToken: "rivera-7k2",
      timezone: "America/New_York",
    });
    expect(plan.creator).toEqual({
      authSubject: "fixture|m-sam",
      email: "sam@rivera-household.example",
      firstName: "Sam",
      timezone: "America/New_York",
    });
    expect(plan.partner).toMatchObject({ email: "jordan@rivera-household.example", firstName: "Jordan" });
  });

  it("rejects a fixture whose money is not integer cents", () => {
    const bad = structuredClone(fixture) as { household: { cushionCents: number } };
    bad.household.cushionCents = 500.5;
    expect(() => planFixtureSeed(bad)).toThrow(/cushionCents/);
  });
});

describe("seedFixture (as mp_api, plan via mp_worker)", () => {
  let api: ApiDb;
  let worker: WorkerDb;
  beforeAll(() => {
    api = createApiDb({ connectionString: inject("databaseUrl") });
    worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl") });
  });
  afterAll(async () => {
    await api.close();
    await worker.close();
  });

  const snapshot = (userId: string) =>
    api.withHouseholdTx({ userId }, async (tx) => ({
      households: (
        await tx.execute(
          sql`select id, name, timezone, plan, cushion_cents, forwarding_token from households`,
        )
      ).rows,
      members: (
        await tx.execute(sql`select u.first_name, u.email, m.color_role, m.is_creator from household_members m
          join users u on u.id = m.user_id where m.left_at is null order by m.color_role`)
      ).rows,
    }));

  it("inserts the fixture household and members, and is idempotent", async () => {
    const fixture: unknown = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
    const first = await seedFixture({ api, worker }, fixture);
    expect(first.created).toBe(true);
    const second = await seedFixture({ api, worker }, fixture);
    expect(second.created).toBe(false);
    expect(second.userIds).toEqual(first.userIds);

    const sam = await snapshot(first.userIds.creator);
    expect(sam.households).toEqual([
      {
        id: fixtureUuid("hh-rivera"),
        name: "Rivera household",
        timezone: "America/New_York",
        plan: "family_plus",
        cushion_cents: "50000",
        forwarding_token: "rivera-7k2",
      },
    ]);
    expect(sam.members).toEqual([
      { first_name: "Sam", email: "sam@rivera-household.example", color_role: "partnerA", is_creator: true },
      {
        first_name: "Jordan",
        email: "jordan@rivera-household.example",
        color_role: "partnerB",
        is_creator: false,
      },
    ]);
    expect(await snapshot(first.userIds.partner)).toEqual(sam);
  });

  it("the db:seed and db:migrate CLIs run against the same database", async () => {
    const env = {
      ...process.env,
      DATABASE_URL: inject("databaseUrl"),
      WORKER_DATABASE_URL: inject("workerDatabaseUrl"),
      MIGRATOR_DATABASE_URL: inject("migratorDatabaseUrl"),
    };
    const cli = (name: string) =>
      run(process.execPath, ["--import", "tsx", resolve(REPO_ROOT, `packages/db/src/cli/${name}.ts`)], {
        env,
        cwd: REPO_ROOT,
      });
    expect((await cli("migrate")).stdout).toMatch(/0 applied/);
    expect((await cli("seed")).stdout).toMatch(/already seeded/);
  });
});
