// Builds the provider clients from the environment, shared by apps/api (consent, token exchange) and apps/worker
// (refresh, watch, listing). A provider with none of its settings is simply off; one with only some of them is a
// configuration mistake that stops the process at startup instead of failing on the first connect.
import { GmailProvider } from "./gmail";
import { GraphProvider } from "./graph";
import type { FetchLike } from "./http";
import type { MailProvider, MailProviderId } from "./types";

export interface ProviderEnv {
  /** Public origin of the API, for the OAuth redirect URI and the Graph notification URL. */
  API_PUBLIC_URL?: string | undefined;
  GOOGLE_GMAIL_CLIENT_ID?: string | undefined;
  GOOGLE_GMAIL_CLIENT_SECRET?: string | undefined;
  /** `projects/{project}/topics/{topic}`. Optional: without it Gmail has no push and the poll finds new mail. */
  GMAIL_PUBSUB_TOPIC?: string | undefined;
  MICROSOFT_OAUTH_CLIENT_ID?: string | undefined;
  MICROSOFT_OAUTH_CLIENT_SECRET?: string | undefined;
}

export class ProviderConfigError extends Error {
  override readonly name = "ProviderConfigError";
}

export type Providers = Partial<Record<MailProviderId, MailProvider>>;

function all(env: ProviderEnv, keys: (keyof ProviderEnv)[], label: string): boolean {
  const set = keys.filter((k) => env[k]);
  if (set.length === 0) return false;
  if (set.length < keys.length) {
    throw new ProviderConfigError(`${label} is only partly configured: set ${keys.join(", ")}.`);
  }
  return true;
}

export function createProvidersFromEnv(
  env: ProviderEnv,
  options: { fetch?: FetchLike; now?: () => number } = {},
): Providers {
  const out: Providers = {};
  const gmail = all(env, ["GOOGLE_GMAIL_CLIENT_ID", "GOOGLE_GMAIL_CLIENT_SECRET"], "Gmail");
  const outlook = all(env, ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"], "Outlook");
  if (!gmail && !outlook) return out;
  const base = env.API_PUBLIC_URL;
  if (!base) throw new ProviderConfigError("API_PUBLIC_URL is required when Gmail or Outlook is configured.");
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    throw new ProviderConfigError("API_PUBLIC_URL is not a URL.");
  }
  const at = (path: string) => new URL(path, origin).toString();
  if (gmail) {
    out.gmail = new GmailProvider(
      {
        clientId: env.GOOGLE_GMAIL_CLIENT_ID ?? "",
        clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET ?? "",
        redirectUri: at("/v1/email-connections/gmail/callback"),
        ...(env.GMAIL_PUBSUB_TOPIC ? { pubsubTopic: env.GMAIL_PUBSUB_TOPIC } : {}),
      },
      options.fetch,
      options.now,
    );
  }
  if (outlook) {
    out.outlook = new GraphProvider(
      {
        clientId: env.MICROSOFT_OAUTH_CLIENT_ID ?? "",
        clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET ?? "",
        redirectUri: at("/v1/email-connections/outlook/callback"),
        notificationUrl: at("/webhooks/graph"),
      },
      options.fetch,
      options.now,
    );
  }
  return out;
}
