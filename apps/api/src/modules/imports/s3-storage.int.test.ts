// WP-32: the S3 adapter against a real MinIO (Testcontainers), the same server docker compose runs locally. Supabase
// Storage's S3 endpoint speaks the same dialect (path-style, SigV4); the owner checks that one by hand (runbook).
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3ImportStorage, loadS3Config, S3ConfigError, type S3StorageConfig } from "./s3-storage";
import { importKey } from "./storage";

const MINIO_IMAGE =
  "ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9"; // same pin as docker-compose.yml (Q-210)
const BUCKET = "imports";
let container: StartedTestContainer;
let config: S3StorageConfig;

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
  const admin = new S3Client({
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

const HOUSEHOLD = "11111111-1111-4111-8111-111111111111";
const CSV = "Date,Description,Amount\n2026-10-01,Synthetic Energy Co,-84.12\n";
const bytes = (text: string) => new TextEncoder().encode(text);

async function putTo(
  upload: { method: string; url: string; headers: Record<string, string> },
  body: Uint8Array,
  headers = {},
) {
  return fetch(upload.url, {
    method: upload.method,
    headers: { ...upload.headers, ...headers },
    body,
  });
}

describe("createUpload, head and delete against MinIO", () => {
  it("returns a PUT that stores exactly the declared bytes, then head sees the size and delete removes it", async () => {
    const storage = createS3ImportStorage(config);
    const key = importKey(HOUSEHOLD, "22222222-2222-4222-8222-222222222222");
    const body = bytes(CSV);
    expect(await storage.head(key)).toBeNull();

    const upload = await storage.createUpload({
      key,
      contentType: "text/csv",
      maxBytes: body.byteLength,
      expiresInSeconds: 600,
    });
    expect(upload.method).toBe("PUT");
    expect(upload.fields).toEqual({});
    expect(upload.headers).toEqual({ "content-type": "text/csv" });
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Path-style, and the signature carries the size and type.
    expect(new URL(upload.url).pathname).toBe(`/${BUCKET}/${key}`);
    expect(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");

    const res = await putTo(upload, body);
    expect(res.status).toBe(200);
    expect(await storage.head(key)).toEqual({ sizeBytes: body.byteLength });

    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    await storage.delete(key); // deleting a missing object is not an error
  });

  it("refuses a body larger than the signed size and one of another content type", async () => {
    const storage = createS3ImportStorage(config);
    const key = importKey(HOUSEHOLD, "33333333-3333-4333-8333-333333333333");
    const upload = await storage.createUpload({
      key,
      contentType: "text/csv",
      maxBytes: 10,
      expiresInSeconds: 600,
    });
    const tooBig = await putTo(upload, bytes(CSV));
    expect(tooBig.status).toBe(403);
    const wrongType = await putTo(upload, bytes("0123456789"), { "content-type": "application/zip" });
    expect(wrongType.status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it("refuses an expired URL", async () => {
    const storage = createS3ImportStorage(config);
    const upload = await storage.createUpload({
      key: importKey(HOUSEHOLD, "44444444-4444-4444-8444-444444444444"),
      contentType: "text/csv",
      maxBytes: 3,
      expiresInSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await putTo(upload, bytes("abc"))).status).toBe(403);
  });

  it("signs for the public endpoint when it differs from the one the API uses", async () => {
    const storage = createS3ImportStorage({ ...config, publicEndpoint: "http://localhost:9000" });
    const upload = await storage.createUpload({
      key: "imports/x.csv",
      contentType: "text/csv",
      maxBytes: 3,
      expiresInSeconds: 60,
    });
    expect(new URL(upload.url).origin).toBe("http://localhost:9000");
  });
});

describe("loadS3Config", () => {
  it("is null without an endpoint, defaults region and bucket, and rejects half a configuration", () => {
    expect(loadS3Config({})).toBeNull();
    expect(() => loadS3Config({ S3_ENDPOINT: "http://localhost:9000" })).toThrow(S3ConfigError);
    expect(() =>
      loadS3Config({ S3_ENDPOINT: "nope", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b" }),
    ).toThrow(/not a URL/);
    expect(
      loadS3Config({
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "a",
        S3_SECRET_ACCESS_KEY: "b",
      }),
    ).toMatchObject({ region: "us-east-1", bucket: "imports" });
    expect(
      loadS3Config({
        S3_ENDPOINT: "https://x.storage.supabase.co/storage/v1/s3",
        S3_REGION: "us-east-2",
        S3_BUCKET_IMPORTS: "imp",
        S3_ACCESS_KEY_ID: "a",
        S3_SECRET_ACCESS_KEY: "b",
      }),
    ).toMatchObject({ region: "us-east-2", bucket: "imp" });
  });
});
