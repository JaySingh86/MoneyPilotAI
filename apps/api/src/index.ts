import { createProviderFromEnv } from "@mp/billing";
import { createLogger } from "@mp/observability";
import { createAuthenticator } from "./auth/authenticator";
import { AuthConfigError, loadCognitoConfig } from "./auth/config";
import { createCognitoProvider } from "./auth/cognito";
import { createEmailSender, createInviteSender, type InviteSenderPort } from "@mp/notify";
import { configureRuntime } from "./auth/runtime";
import { loadEmailConfig } from "./modules/email";
import { createDbSendQuota } from "./modules/notify";
import { unauthorized, type AuthProvider } from "./auth/provider";
import { DbTlsError, pgConfig, tlsWarning } from "@mp/db";
import { createSharedDb, installShutdown } from "./lib/db-pool";
import { configureImportStorage } from "./modules/imports";
import { createS3ImportStorage, loadS3Config } from "./modules/imports/s3-storage";
import { buildServer } from "./server";

const log = createLogger("api");
const port = Number(process.env.API_PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log.error("DATABASE_URL is not set");
  process.exit(1);
}
// TLS to the database (ADR-020): Supabase hosts are verified; production refuses an unverified remote database.
try {
  pgConfig(databaseUrl);
} catch (err) {
  if (!(err instanceof DbTlsError)) throw err;
  log.error({ reason: err.message }, "database TLS is misconfigured; refusing to start");
  process.exit(1);
}
const tlsProblem = tlsWarning([databaseUrl]);
if (tlsProblem) log.warn(tlsProblem);
// The one pool of the process: every module reaches it through the runtime and it is closed on shutdown.
const pool = createSharedDb({ connectionString: databaseUrl });
const db = pool.db;

// Cognito (ADR-017). In production a missing or inconsistent setting stops the API at startup. Elsewhere,
// without a user pool (local dev before WP-09) every token is refused and only anonymous routes such as
// /health answer; there is no development bypass.
let provider: AuthProvider;
try {
  const cognito = loadCognitoConfig(process.env);
  if (cognito) {
    provider = createCognitoProvider(cognito);
  } else {
    log.warn("COGNITO_* is not configured: every access token will be refused");
    const notConfigured = () => unauthorized("Sign-in is not configured on this server.");
    provider = {
      verifyToken: async () => {
        throw notConfigured();
      },
      getUser: () => {
        throw notConfigured();
      },
      requireStepUp: () => {
        throw notConfigured();
      },
    };
  }
} catch (err) {
  if (err instanceof AuthConfigError) {
    log.error({ reason: err.message }, "auth is misconfigured; refusing to start");
    process.exit(1);
  }
  throw err;
}

// Billing (WP-25): a misconfigured provider (an unknown name, or the fake outside development and test) stops
// the API at startup instead of letting it run without the billing it was asked to have.
try {
  createProviderFromEnv(process.env);
} catch (err) {
  log.error(
    { reason: err instanceof Error ? err.message : "invalid" },
    "billing is misconfigured; refusing to start",
  );
  process.exit(1);
}

// Email connections (WP-21): off without provider settings; a partly configured provider, a missing secret or an
// unusable key provider stops the API here instead of failing on the first connect.
try {
  loadEmailConfig(process.env);
} catch (err) {
  log.error(
    { reason: err instanceof Error ? err.message : "invalid" },
    "email connections are misconfigured; refusing to start",
  );
  process.exit(1);
}

// Invite emails (WP-15, Q-081): SES in production, Mailpit locally. Production without EMAIL_TRANSPORT stops the
// API at startup, so an invite is never reported as sent when it was not.
let inviteSender: InviteSenderPort;
try {
  inviteSender = createInviteSender({
    email: createEmailSender(process.env),
    quota: createDbSendQuota(db),
    // Production must set WEB_ORIGIN (an empty URL makes createInviteSender throw).
    appUrl: webOrigin ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3100"),
  });
} catch (err) {
  log.error({ err }, "email delivery is misconfigured; refusing to start");
  process.exit(1);
}
configureRuntime({ db, provider, inviteSender });

// CSV upload storage (WP-32): MinIO locally, Supabase Storage's S3 endpoint in the real-data phase. Without S3_*
// settings uploads answer 503 and the rest of the API works.
try {
  const s3 = loadS3Config(process.env);
  if (s3) configureImportStorage(createS3ImportStorage(s3));
  else log.warn("S3_ENDPOINT is not set: CSV uploads are unavailable");
} catch (err) {
  log.error(
    { reason: err instanceof Error ? err.message : "invalid" },
    "storage is misconfigured; refusing to start",
  );
  process.exit(1);
}

// TODO(WP-26): database-backed idempotency store (lib/idempotency-store.ts); the in-memory default is per process.
const app = buildServer({
  logger: log,
  authenticate: createAuthenticator({ provider, db }),
  corsOrigins: webOrigin ? [webOrigin] : [],
  // Behind the ALB in AWS (one hop). Locally nothing is in front, so X-Forwarded-For is not trusted.
  trustProxy: process.env.NODE_ENV === "production" ? 1 : false,
});

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => log.info({ port }, "api listening"))
  .catch((err: unknown) => {
    log.error({ err }, "api failed to start");
    process.exit(1);
  });

installShutdown(app, pool, process, (error) => {
  if (error) log.error({ err: error }, "api did not shut down cleanly");
  process.exit(error ? 1 : 0);
});
