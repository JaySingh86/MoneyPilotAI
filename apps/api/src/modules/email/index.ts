// Email module (WP-21): connect and disconnect Gmail and Outlook mailboxes, the OAuth callback and the two provider
// push webhooks. Provider clients and the seal-only key provider come from the environment (`loadEmailConfig`);
// without provider settings the routes answer 503 and nothing else is affected.
import { createDataKeyGenerator, type EncryptDeps } from "@mp/crypto/encrypt";
import { createOAuthClientsFromEnv, ProviderConfigError, type ProviderEnv } from "@mp/email/oauth";
import { defineModule, WEBHOOKS_PREFIX, type ApiModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { emailRoutes, emailWebhookRoutes } from "./routes";
import type { EmailDeps } from "./service";

export { combineLeaveHooks, emailLeaveHooks } from "./leave-hooks";
export { countActive as countActiveEmailConnections } from "./repo";

export interface EmailEnv extends ProviderEnv {
  NODE_ENV?: string | undefined;
  WEB_ORIGIN?: string | undefined;
  EMAIL_ADDRESS_HASH_KEY?: string | undefined;
  EMAIL_WEBHOOK_SECRET?: string | undefined;
  GMAIL_PUSH_AUDIENCE?: string | undefined;
  GMAIL_PUSH_SERVICE_ACCOUNT?: string | undefined;
  TOKEN_MASTER_KEY?: string | undefined;
  KMS_TOKEN_KEY_ID?: string | undefined;
  AWS_REGION?: string | undefined;
}

function secret(value: string | undefined, name: string): Buffer {
  const buf = Buffer.from(value ?? "", "base64");
  if (buf.length < 32) throw new ProviderConfigError(`${name} must be base64 of at least 32 random bytes.`);
  return buf;
}

export type EmailConfig = Omit<EmailDeps, "db">;

/**
 * Null when no provider is configured (the feature is off). A partly configured provider, a missing secret or an
 * unusable key provider throws, so the API stops at startup instead of failing on the first connect.
 */
export function loadEmailConfig(env: EmailEnv, crypto: EncryptDeps = {}): EmailConfig | null {
  const providers = createOAuthClientsFromEnv(env);
  if (!providers.gmail && !providers.outlook) return null;
  if (!env.WEB_ORIGIN && env.NODE_ENV === "production") {
    throw new ProviderConfigError("WEB_ORIGIN is required for the OAuth return redirect.");
  }
  // Pub/Sub push needs a public endpoint. Without a topic (local development) there is no push; the worker polls.
  let gmailPush: EmailConfig["gmailPush"] = null;
  if (providers.gmail && env.GMAIL_PUBSUB_TOPIC) {
    if (!env.GMAIL_PUSH_AUDIENCE || !env.GMAIL_PUSH_SERVICE_ACCOUNT) {
      throw new ProviderConfigError("Gmail push needs GMAIL_PUSH_AUDIENCE and GMAIL_PUSH_SERVICE_ACCOUNT.");
    }
    gmailPush = { audience: env.GMAIL_PUSH_AUDIENCE, serviceAccountEmail: env.GMAIL_PUSH_SERVICE_ACCOUNT };
  }
  return {
    providers: (id) => providers[id] ?? null,
    keys: createDataKeyGenerator(env, crypto),
    addressHashKey: secret(env.EMAIL_ADDRESS_HASH_KEY, "EMAIL_ADDRESS_HASH_KEY"),
    graphStateSecret: secret(env.EMAIL_WEBHOOK_SECRET, "EMAIL_WEBHOOK_SECRET"),
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:3100",
    gmailPush,
  };
}

export interface EmailOptions {
  /** Default: `loadEmailConfig(process.env)` at the first request (null when off). */
  config?: EmailConfig | null;
}

export function createEmailModules(
  source: RuntimeSource = runtime,
  options: EmailOptions = {},
): readonly ApiModule[] {
  let fromEnv: EmailConfig | null | undefined;
  const config = (): EmailConfig | null => {
    if (options.config !== undefined) return options.config;
    fromEnv ??= loadEmailConfig(process.env);
    return fromEnv;
  };
  // With the feature off every route answers 503 (providers() is null), and no secret is needed.
  const off: EmailConfig = {
    providers: () => null,
    keys: {
      keyId: () => "",
      generateDataKey: async () => {
        throw new Error("Email connections are not configured.");
      },
    },
    addressHashKey: Buffer.alloc(32),
    graphStateSecret: Buffer.alloc(32),
    webOrigin: "http://localhost:3100",
    gmailPush: null,
  };
  const deps = (): EmailDeps => ({ db: source().db, ...(config() ?? off) });
  return [
    defineModule({ name: "email", routes: emailRoutes(deps, () => source().provider) }),
    defineModule({ name: "email-webhook", prefix: WEBHOOKS_PREFIX, routes: emailWebhookRoutes(deps) }),
  ];
}

export const emailModules = createEmailModules();
