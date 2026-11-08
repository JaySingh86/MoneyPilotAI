// pnpm storage:init — creates the private `imports` bucket on local MinIO (docker compose). On Supabase the bucket
// is created in the dashboard (runbook step 6), because its S3 layer does not create buckets.
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadS3Config } from "../modules/imports/s3-storage";

const envFile = resolve(import.meta.dirname, "../../../../.env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const say = (message: string): void => void process.stdout.write(`${message}\n`);

const config = loadS3Config(process.env);
if (!config) {
  say("S3_ENDPOINT is not set (see .env.example).");
  process.exit(1);
}
const host = new URL(config.endpoint).hostname;
const s3 = new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  forcePathStyle: true,
});
try {
  await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
  say(`bucket ${config.bucket} exists`);
} catch {
  if (host !== "localhost" && host !== "127.0.0.1") {
    say(
      `bucket ${config.bucket} was not found. Create it in the Supabase dashboard (Storage -> New bucket, private).`,
    );
    process.exit(1);
  }
  await s3.send(new CreateBucketCommand({ Bucket: config.bucket }));
  say(`created bucket ${config.bucket} (MinIO buckets are private by default)`);
}
