// S3 adapter behind `ImportFileStore` (WP-32, ADR-020): the worker reads an uploaded CSV and deletes it after
// processing. Same `S3_*` settings and the same path-style, no-extra-checksum client as the API's adapter
// (apps/api/src/modules/imports/s3-storage.ts); the worker never signs URLs.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { ImportFileStore } from "./storage";

export interface S3FileStoreConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3ConfigError extends Error {
  override readonly name = "S3ConfigError";
}

/** Reads `S3_*`. Returns null when no endpoint is set (the job then fails and retries, as before). */
export function loadS3Config(env: NodeJS.ProcessEnv): S3FileStoreConfig | null {
  const endpoint = env.S3_ENDPOINT;
  if (!endpoint) return null;
  const missing = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (missing.length > 0) throw new S3ConfigError(`${missing.join(" and ")} must be set with S3_ENDPOINT.`);
  try {
    new URL(endpoint);
  } catch {
    throw new S3ConfigError("S3_ENDPOINT is not a URL.");
  }
  return {
    endpoint,
    region: env.S3_REGION || "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    bucket: env.S3_BUCKET_IMPORTS || "imports",
  };
}

/** The one S3 client method used, so a test can stand in for the server. */
export type S3Like = Pick<S3Client, "send">;

const isMissing = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 || error.name === "NoSuchKey" || error.name === "NotFound");

/**
 * `maxBytes` bounds what is read: a larger object is cut one byte past the limit with a Range request, so the
 * job's own size check still fails it ("too_large") without pulling the whole object into memory.
 */
export function createS3ImportFileStore(
  config: S3FileStoreConfig,
  maxBytes: number,
  client?: S3Like,
): ImportFileStore {
  const s3: S3Like =
    client ??
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  return {
    async get(key) {
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${maxBytes}` }),
        );
        // A server that ignores Range would send the whole object. The length header decides, before any byte is
        // read: more than one past the limit (or no length at all) is cut off and reported as over the limit, as
        // a value one byte longer than allowed, which the job's own size check turns into `too_large`.
        const overLimit = res.ContentLength === undefined || res.ContentLength > maxBytes + 1;
        if (overLimit) {
          (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
          return new Uint8Array(maxBytes + 1);
        }
        return (await res.Body?.transformToByteArray()) ?? null;
      } catch (error) {
        if (isMissing(error)) return null;
        // An empty object cannot satisfy a Range request (416): it is an empty file, not a missing one.
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 416)
          return new Uint8Array();
        throw error;
      }
    },
    async list(prefix) {
      const found: { key: string; lastModifiedMs: number }[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of page.Contents ?? []) {
          if (o.Key) found.push({ key: o.Key, lastModifiedMs: o.LastModified?.getTime() ?? 0 });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return found;
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
