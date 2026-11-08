// pnpm --filter @mp/api live:smoke — an end-to-end check of the real-data path on your machine (WP-32), used
// until Supabase Auth (WP-33) lets you sign in through the web app:
//   fake sign-in -> create household -> upload a synthetic CSV to storage -> the worker processes it -> review items.
//
// It starts THIS API in-process on API_SMOKE_PORT (default 4010) against the real database (DATABASE_URL), storage
// (S3_*) and queue, with a locally generated fake token issuer. The worker must be running (`pnpm dev:live`, or
// `pnpm --filter @mp/worker start`) against the same database and storage. The CSV is generated here from
// invented merchants and amounts: never point this at a real bank file. It creates a household named "Smoke ..."
// in whatever database `.env.local` points at; use a local or disposable database.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { createApiDb, tlsMode } from "@mp/db";
import { createAuthenticator } from "../auth/authenticator";
import { createCognitoProvider } from "../auth/cognito";
import { configureRuntime, type ApiRuntime } from "../auth/runtime";
import { FakeIssuer } from "../auth/testing/fake-issuer";
import { configureImportStorage } from "../modules/imports";
import { createS3ImportStorage, loadS3Config } from "../modules/imports/s3-storage";
import { buildServer } from "../server";

const root = resolve(import.meta.dirname, "../../../..");
const envFile = resolve(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const say = (message: string): void => void process.stdout.write(`${message}\n`);
// This script signs in with a fake token issuer and writes a household: it must never run against a shared or
// production database, so it refuses anything but this machine.
if (process.env.NODE_ENV === "production")
  throw new Error("live:smoke is a development tool and refuses NODE_ENV=production.");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example).");
if (tlsMode(databaseUrl, {}) !== "local") {
  throw new Error(
    "live:smoke only runs against a local database (localhost, 127.0.0.1 or ::1), never a remote one.",
  );
}
const s3 = loadS3Config(process.env);
if (!s3) throw new Error("S3_ENDPOINT is not set (see .env.example).");

/** Three months of a synthetic energy bill and a streaming charge, plus noise, in a common bank layout. */
function syntheticCsv(): string {
  const rows = ["Date,Description,Amount"];
  const today = Temporal.Now.plainDateISO("America/New_York");
  for (let m = 5; m >= 1; m--) {
    const month = today.subtract({ months: m });
    const iso = (day: number) => month.with({ day }).toString();
    rows.push(`${iso(12)},SYNTHETIC ENERGY CO,-${(80 + m).toFixed(2)}`);
    rows.push(`${iso(3)},EXAMPLE STREAMING PLUS,-15.99`);
    rows.push(`${iso(20 + (m % 5))},CORNER STORE ${m},-${(10 + m * 3).toFixed(2)}`);
  }
  return `${rows.join("\n")}\n`;
}

/**
 * The ONLY place this script knows how sign-in works: a fake token issuer standing in for the real one.
 * TODO(WP-33 merge): `auth/cognito.ts` and `FakeIssuer` are replaced by `SupabaseAuthProvider` and `FakeSupabase`.
 * Port this function (and nothing else) to build the provider from `FakeSupabase` and mint an access token with
 * an `email` claim and a verified email; `provider` goes to `configureRuntime`/`createAuthenticator` below.
 */
async function createSmokeAuth(): Promise<{
  provider: ApiRuntime["provider"];
  accessToken(subject: string, email: string): Promise<string>;
}> {
  const issuer = await FakeIssuer.create();
  return {
    provider: createCognitoProvider(issuer.cognitoConfig()),
    accessToken: (subject, email) => issuer.accessToken(subject, { claims: { email } }),
  };
}

const { provider, accessToken } = await createSmokeAuth();
const db = createApiDb({ connectionString: databaseUrl, max: 4 });
configureRuntime({ db, provider, inviteSender: { send: async () => undefined } });
configureImportStorage(createS3ImportStorage(s3));
const app = buildServer({ authenticate: createAuthenticator({ provider, db }) });
await app.listen({ port: Number(process.env.API_SMOKE_PORT ?? 4010), host: "127.0.0.1" });
const base = `http://127.0.0.1:${Number(process.env.API_SMOKE_PORT ?? 4010)}`;

async function call<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

let exitCode = 0;
try {
  const subject = `smoke-${randomUUID()}`;
  const auth = { authorization: `Bearer ${await accessToken(subject, `${subject}@example.test`)}` };
  const key = () => ({ ...auth, "idempotency-key": randomUUID() });
  await call("POST", "/v1/me/bootstrap", key(), { firstName: "Smoke" });
  const household = await call<{ id: string }>("POST", "/v1/households", key(), {
    name: `Smoke ${Temporal.Now.instant().toString().slice(0, 16)}`,
    timezone: "America/New_York",
  });
  say("household created");

  const csv = syntheticCsv();
  const size = new TextEncoder().encode(csv).byteLength;
  const created = await call<{
    import: { id: string };
    upload: { method: string; url: string; headers: Record<string, string> };
  }>("POST", `/v1/households/${household.id}/imports`, key(), {
    filename: "synthetic-statement.csv",
    sizeBytes: size,
    contentType: "text/csv",
  });
  const put = await fetch(created.upload.url, {
    method: created.upload.method,
    headers: created.upload.headers,
    body: csv,
  });
  if (!put.ok) throw new Error(`storage upload -> ${put.status}`);
  say(`uploaded ${size} bytes to storage`);

  await call("POST", `/v1/households/${household.id}/imports/${created.import.id}/process`, key());
  say("processing requested; waiting for the worker (it can take up to a minute)");
  let status = "processing";
  for (let i = 0; i < 150 && (status === "processing" || status === "uploaded"); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (
      await call<{ status: string }>(
        "GET",
        `/v1/households/${household.id}/imports/${created.import.id}`,
        auth,
      )
    ).status;
  }
  if (status === "needs_mapping") {
    // A bank layout we have not seen: a person picks the columns (here, the three of our synthetic file).
    say("unknown layout: sending a column mapping, as the setup screen would");
    await call("PUT", `/v1/households/${household.id}/imports/${created.import.id}/mapping`, key(), {
      date: "Date",
      description: "Description",
      amount: "Amount",
      amountSign: "outflow_negative",
    });
    status = "processing";
    for (let i = 0; i < 150 && (status === "processing" || status === "uploaded"); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      status = (
        await call<{ status: string }>(
          "GET",
          `/v1/households/${household.id}/imports/${created.import.id}`,
          auth,
        )
      ).status;
    }
  }
  say(`import status: ${status}`);
  const queue = await call<{ data: { source: string }[] }>(
    "GET",
    `/v1/households/${household.id}/review-items?state=queued`,
    auth,
  );
  say(`review items from csv: ${queue.data.filter((i) => i.source === "csv").length}`);
  if (status !== "done" || queue.data.length === 0) exitCode = 1;
} catch (error) {
  say(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await app.close();
  await db.close();
}
process.exit(exitCode);
