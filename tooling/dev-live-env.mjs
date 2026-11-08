// Which settings `pnpm dev:live` passes to each process (WP-32). `.env.local` holds every secret of the project; the
// web dev server (which runs third-party code) must see none of them, and the API and worker only their own.
// Never passed to anyone: SUPABASE_ADMIN_URL (one-time bootstrap) and NEXT_PUBLIC_MP_MOCK (mock mode).

/** What any child process needs to run at all. */
const BASICS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  "NODE_OPTIONS",
  "LOG_LEVEL",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
]);
const BASIC_PREFIXES = ["npm_", "PNPM_", "COREPACK_", "NODE_EXTRA_CA"];

const MAIL = [
  "EMAIL_TRANSPORT",
  "EMAIL_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SES_CONFIGURATION_SET",
  "AWS_REGION",
];
const STORAGE = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_IMPORTS"];
// Token encryption and the Gmail connection (WP-21): the runbook gives these to both the API and the worker.
const EMAIL_INTEGRATION = [
  "TOKEN_MASTER_KEY",
  "KMS_TOKEN_KEY_ID",
  "EMAIL_ADDRESS_HASH_KEY",
  "EMAIL_WEBHOOK_SECRET",
  "EMAIL_POLL_MINUTES",
  "API_PUBLIC_URL",
  "GOOGLE_GMAIL_CLIENT_ID",
  "GOOGLE_GMAIL_CLIENT_SECRET",
  "GMAIL_PUBSUB_TOPIC",
  "GMAIL_PUSH_AUDIENCE",
  "GMAIL_PUSH_SERVICE_ACCOUNT",
  "MICROSOFT_OAUTH_CLIENT_ID",
  "MICROSOFT_OAUTH_CLIENT_SECRET",
];

const ALLOW = {
  web: { exact: ["PORT", "WEB_PORT"], prefixes: ["NEXT_PUBLIC_"] },
  api: {
    exact: [
      "API_PORT",
      "WEB_ORIGIN",
      "DATABASE_URL",
      "MP_DB_TLS_INSECURE",
      "S3_PUBLIC_ENDPOINT",
      ...STORAGE,
      ...MAIL,
      "SES_EVENTS_TOPIC_ARNS",
      "BILLING_PROVIDER",
      "BILLING_WEBHOOK_SECRET",
      // Auth (ADR-020): only the API holds the Supabase keys and the Google state-cookie secret.
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "AUTH_COOKIE_SECRET", // API_PUBLIC_URL comes with EMAIL_INTEGRATION
      ...EMAIL_INTEGRATION,
    ],
    prefixes: [],
  },
  worker: {
    // The worker needs the queue role (PGBOSS_DATABASE_URL), not the migrator: dev:live refuses to start without it.
    exact: [
      "WORKER_DATABASE_URL",
      "PGBOSS_DATABASE_URL",
      "MP_DB_TLS_INSECURE",
      "WEB_ORIGIN",
      ...STORAGE,
      ...MAIL,
      ...EMAIL_INTEGRATION,
      "ANTHROPIC_API_KEY",
    ],
    prefixes: [],
  },
};

/** The environment for one process: the basics plus its own allow-list, copied from the shell's environment. */
export function envFor(name, parentEnv) {
  const rule = ALLOW[name];
  if (!rule) throw new Error(`Unknown process ${name}`);
  const exact = new Set(rule.exact);
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const allowed =
      BASICS.has(key) ||
      BASIC_PREFIXES.some((p) => key.startsWith(p)) ||
      exact.has(key) ||
      rule.prefixes.some((p) => key.startsWith(p));
    if (allowed) env[key] = value;
  }
  // Mock mode is a flag of `pnpm dev`; live mode must never inherit it.
  delete env.NEXT_PUBLIC_MP_MOCK;
  return env;
}

/** Settings live mode cannot start without. */
export function missingKeys(env) {
  return ["DATABASE_URL", "WORKER_DATABASE_URL", "PGBOSS_DATABASE_URL", "NEXT_PUBLIC_API_URL"].filter(
    (k) => !env[k],
  );
}
