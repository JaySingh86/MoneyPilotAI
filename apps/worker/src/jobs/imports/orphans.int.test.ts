// `imports.orphans` (WP-32, security review): the upload URL cannot stop someone from leaving files in the bucket
// (an upload that is never processed, a key with no `imports` row). This sweep deletes them after a grace period,
// against a real MinIO and a real Postgres as mp_worker.
import { randomUUID } from "node:crypto";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "@mp/db";
import { createHousehold, ensureUser } from "@mp/db/testing";
import { handleImportsOrphans } from "./orphans";
import { createS3ImportFileStore, type S3FileStoreConfig } from "./s3-storage";
import type { ImportFileStore } from "./storage";

const MINIO_IMAGE =
  "ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9";
const BUCKET = "imports";
const HOUR = 3_600_000;

let container: StartedTestContainer;
let config: S3FileStoreConfig;
let s3: S3Client;
let store: ImportFileStore;
let api: ApiDb;
let worker: WorkerDb;
let admin: pg.Client;
let hid: string;
let userId: string;

beforeAll(async () => {
  container = await new GenericContainer(MINIO_IMAGE)
    .withCommand(["server", "/data"])
    .withEnvironment({ MINIO_ROOT_USER: "mp_test", MINIO_ROOT_PASSWORD: "mp_test_secret" })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  config = {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    region: "us-east-1",
    accessKeyId: "mp_test",
    secretAccessKey: "mp_test_secret",
    bucket: BUCKET,
  };
  s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  store = createS3ImportFileStore(config, 1024);

  api = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 2 });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  admin = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  await admin.connect();
  const owner = await ensureUser(api, {
    authSubject: `orphans|${randomUUID()}`,
    email: `orphans-${randomUUID().slice(0, 8)}@example.test`,
    firstName: "Orphans",
    timezone: "America/New_York",
  });
  hid = randomUUID();
  userId = owner.id;
  await createHousehold(api, owner, {
    id: hid,
    name: "Orphans",
    timezone: "America/New_York",
    forwardingToken: `orph-${hid.slice(0, 8)}`,
  });
}, 240_000);

afterAll(async () => {
  await container?.stop();
  await admin?.end();
  await api?.close();
  await worker?.close();
});

const putObject = (key: string) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "a,b\n1,2\n", ContentType: "text/csv" }));
const exists = async (key: string) => (await store.list!("imports/")).some((o) => o.key === key);

async function importRow(status: string, opts: { keyed: boolean }): Promise<string> {
  const id = randomUUID();
  const key = `imports/${hid}/${id}.csv`;
  await putObject(key);
  await admin.query(
    `insert into imports (id, household_id, uploaded_by, s3_key, filename, size_bytes, status)
     values ($1, $2, $3, $4, 'b.csv', 8, $5)`,
    [id, hid, userId, opts.keyed ? key : null, status],
  );
  return key;
}

describe("imports.orphans", () => {
  it("keeps every young object, whatever its row says", async () => {
    const orphan = `imports/${hid}/${randomUUID()}.csv`;
    await putObject(orphan);
    const uploaded = await importRow("uploaded", { keyed: true });
    const result = await handleImportsOrphans({ db: worker, store, now: () => Date.now(), maxAgeHours: 24 });
    expect(result.deleted).toBe(0);
    expect(await exists(orphan)).toBe(true);
    expect(await exists(uploaded)).toBe(true);
  });

  it("after the grace period deletes objects with no row, never processed, or already purged, and keeps the rest", async () => {
    const orphan = `imports/${hid}/${randomUUID()}.csv`;
    await putObject(orphan);
    const strangerHousehold = `imports/${randomUUID()}/${randomUUID()}.csv`; // no such household
    await putObject(strangerHousehold);
    const odd = "imports/not-a-real-key.txt";
    await putObject(odd);
    // 36 characters that pass a loose hex-and-dash check but are not UUIDs: must not abort the sweep.
    const notUuid = `imports/${"-".repeat(36)}/${"a".repeat(36)}.csv`;
    await putObject(notUuid);
    const never = await importRow("uploaded", { keyed: true });
    const purged = await importRow("done", { keyed: false }); // the file was meant to be gone
    const needsMapping = await importRow("needs_mapping", { keyed: true });
    const processing = await importRow("processing", { keyed: true });
    const doneKept = await importRow("done", { keyed: true }); // imports.sweep's clean-up owns this one

    const later = Date.now() + 25 * HOUR;
    const result = await handleImportsOrphans({ db: worker, store, now: () => later, maxAgeHours: 24 });
    expect(result.deleted).toBeGreaterThanOrEqual(6);

    for (const gone of [orphan, strangerHousehold, odd, notUuid, never, purged])
      expect(await exists(gone), gone).toBe(false);
    for (const kept of [needsMapping, processing, doneKept]) expect(await exists(kept), kept).toBe(true);
  });

  it("the grace period is configurable", async () => {
    const key = `imports/${hid}/${randomUUID()}.csv`;
    await putObject(key);
    const inTwoHours = Date.now() + 2 * HOUR;
    expect(
      (await handleImportsOrphans({ db: worker, store, now: () => inTwoHours, maxAgeHours: 3 })).deleted,
    ).toBe(0);
    expect(await exists(key)).toBe(true);
    await handleImportsOrphans({ db: worker, store, now: () => inTwoHours, maxAgeHours: 1 });
    expect(await exists(key)).toBe(false);
  });

  it("does nothing when the store cannot list", async () => {
    const result = await handleImportsOrphans({
      db: worker,
      store: { get: async () => null, delete: async () => undefined },
      now: () => Date.now(),
      maxAgeHours: 24,
    });
    expect(result).toEqual({ listed: 0, deleted: 0 });
  });
});
