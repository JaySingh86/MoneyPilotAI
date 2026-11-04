import { createProviderFromEnv } from "@mp/billing";
import { createLogger } from "@mp/observability";
import { createAuthenticator } from "./auth/authenticator";
import { AuthConfigError, loadCognitoConfig } from "./auth/config";
import { createCognitoProvider } from "./auth/cognito";
import { configureRuntime, createUnconfiguredInviteSender } from "./auth/runtime";
import { unauthorized, type AuthProvider } from "./auth/provider";
import { createSharedDb, installShutdown } from "./lib/db-pool";
import { buildServer } from "./server";

const log = createLogger("api");
const port = Number(process.env.API_PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log.error("DATABASE_URL is not set");
  process.exit(1);
}
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

// The invite sender is packages/notify's job (WP-15, Q-081). Until it is wired, this one fails in
// production so an invite is never reported as sent when it was not.
configureRuntime({ db, provider, inviteSender: createUnconfiguredInviteSender(process.env, log) });

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
