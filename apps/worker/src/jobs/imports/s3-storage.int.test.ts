// WP-32: the worker's S3 file store against a real MinIO (Testcontainers). The API's adapter has its own test.
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3ImportFileStore, loadS3Config, S3ConfigError, type S3FileStoreConfig } from "./s3-storage";

const MINIO_IMAGE =
  "ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9"; // same pin as docker-compose.yml (Q-210)
const BUCKET = "imports";
let container: StartedTestContainer;
let config: S3FileStoreConfig;
let admin: S3Client;

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
  admin = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  });
  await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 180_000);
afterAll(async () => {
  await container?.stop();
});

const put = (key: string, body: string | Uint8Array) =>
  admin.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "text/csv" }));
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe("the worker's S3 file store", () => {
  it("reads an object, returns null for a missing one and deletes", async () => {
    const store = createS3ImportFileStore(config, 1024);
    await put("imports/h/a.csv", "Date,Description,Amount\n2026-10-01,Synthetic Energy Co,-84.12\n");
    expect(text(await store.get("imports/h/a.csv"))).toBe(
      "Date,Description,Amount\n2026-10-01,Synthetic Energy Co,-84.12\n",
    );
    expect(await store.get("imports/h/missing.csv")).toBeNull();
    await store.delete("imports/h/a.csv");
    expect(await store.get("imports/h/a.csv")).toBeNull();
    await store.delete("imports/h/a.csv"); // idempotent
  });

  it("reads an empty object as an empty file, not a missing one", async () => {
    const store = createS3ImportFileStore(config, 1024);
    await put("imports/h/empty.csv", "");
    const got = await store.get("imports/h/empty.csv");
    expect(got).not.toBeNull();
    expect(got?.byteLength).toBe(0);
  });

  it("stops reading one byte past the limit, so the job's size check fails it without a full download", async () => {
    const store = createS3ImportFileStore(config, 100);
    await put("imports/h/big.csv", "x".repeat(5000));
    expect((await store.get("imports/h/big.csv"))?.byteLength).toBe(101);
    await put("imports/h/exact.csv", "y".repeat(100));
    expect((await store.get("imports/h/exact.csv"))?.byteLength).toBe(100);
  });
});

describe("loadS3Config", () => {
  it("is null without an endpoint and rejects half a configuration", () => {
    expect(loadS3Config({})).toBeNull();
    expect(() => loadS3Config({ S3_ENDPOINT: "http://localhost:9000" })).toThrow(S3ConfigError);
    expect(
      loadS3Config({
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "a",
        S3_SECRET_ACCESS_KEY: "b",
      }),
    ).toMatchObject({ region: "us-east-1", bucket: "imports" });
  });
});
