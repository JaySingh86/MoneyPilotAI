// S3 adapter behind `ImportStorage` (WP-32, ADR-020, closes Q-143): local MinIO and Supabase Storage's S3 endpoint.
//
// Upload shape: a presigned PUT, not a presigned POST policy. Supabase Storage's S3 layer does not implement POST
// policies (browser form uploads), so `content-length-range` is not available. Instead the URL signs the exact
// `content-length` and `content-type`: a browser sending a different size or type fails the signature check
// before a byte is stored. `maxBytes` from the service is the declared file size, capped at the 10 MB limit, so
// "exactly maxBytes" is also "at most maxBytes". The server still re-checks the stored size at `/process` (head).
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ImportStorage, UploadRequest } from "./storage";

export interface S3StorageConfig {
  /** `http://localhost:9000` (MinIO) or `https://<ref>.storage.supabase.co/storage/v1/s3`. */
  endpoint: string;
  /** The endpoint the BROWSER reaches, when it differs from the one the API uses. Default: `endpoint`. */
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3ConfigError extends Error {
  override readonly name = "S3ConfigError";
}

/** Reads `S3_*` (docs/runbooks/supabase-setup.md). Returns null when no endpoint is set (uploads answer 503). */
export function loadS3Config(env: NodeJS.ProcessEnv): S3StorageConfig | null {
  const endpoint = env.S3_ENDPOINT;
  if (!endpoint) return null;
  const missing = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (missing.length > 0) throw new S3ConfigError(`${missing.join(" and ")} must be set with S3_ENDPOINT.`);
  for (const [name, value] of [
    ["S3_ENDPOINT", endpoint],
    ["S3_PUBLIC_ENDPOINT", env.S3_PUBLIC_ENDPOINT],
  ] as const) {
    if (value === undefined || value === "") continue;
    try {
      new URL(value);
    } catch {
      throw new S3ConfigError(`${name} is not a URL.`);
    }
  }
  return {
    endpoint,
    ...(env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.S3_PUBLIC_ENDPOINT } : {}),
    region: env.S3_REGION || "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    bucket: env.S3_BUCKET_IMPORTS || "imports",
  };
}

function client(config: S3StorageConfig, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Path-style (`<endpoint>/<bucket>/<key>`): MinIO and Supabase Storage do not use bucket sub-domains.
    forcePathStyle: true,
    // Newer SDKs add a CRC32 checksum header to every upload; a presigned PUT from a browser cannot send it and
    // the S3 layer of Supabase Storage rejects the unknown header.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const isMissing = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchKey");

export function createS3ImportStorage(config: S3StorageConfig, now: () => number = Date.now): ImportStorage {
  const server = client(config, config.endpoint);
  const signer = config.publicEndpoint ? client(config, config.publicEndpoint) : server;
  return {
    async createUpload(input): Promise<UploadRequest> {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.maxBytes,
      });
      const url = await getSignedUrl(signer, command, {
        expiresIn: input.expiresInSeconds,
        // Both are part of the signature: a request with another type or size is refused by the store.
        signableHeaders: new Set(["content-type", "content-length"]),
      });
      return {
        method: "PUT",
        url,
        // content-length is set by the browser from the file itself (it is a forbidden request header).
        headers: { "content-type": input.contentType },
        fields: {},
        expiresAt: new Date(now() + input.expiresInSeconds * 1000).toISOString(),
      };
    },
    async head(key) {
      try {
        const res = await server.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return { sizeBytes: res.ContentLength ?? 0 };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      await server.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
