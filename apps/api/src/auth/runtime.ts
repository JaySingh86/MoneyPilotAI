// Dependencies of the identity and households modules, resolved lazily. Module registration must not do
// I/O (lib/module.ts), so the registry holds modules that call `runtime()` inside handlers; `index.ts`
// calls `configureRuntime` once at startup. Tests pass their own runtime to the module factories.
import type { ApiDb } from "@mp/db";
import type { AuthProvider } from "./provider";

/**
 * Sends the partner-invite email. The real sender comes from packages/notify (WP-15, Q-081).
 *
 * `householdName` and `inviterFirstName` are untrusted user text. The API HTML-escapes them before they get
 * here, but renderers MUST still escape for their own context (HTML, plain-text headers, URLs), and must
 * never put them in a Subject or From line unescaped.
 */
export interface InviteSender {
  send(invite: {
    to: string;
    /** The one-time secret for the link. Never log it. */
    token: string;
    householdName: string;
    inviterFirstName: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface ApiRuntime {
  db: ApiDb;
  provider: AuthProvider;
  inviteSender: InviteSender;
}

let configured: ApiRuntime | null = null;

export function configureRuntime(runtime: ApiRuntime): void {
  configured = runtime;
}

export function runtime(): ApiRuntime {
  if (!configured) throw new Error("The API runtime is not configured (call configureRuntime at startup).");
  return configured;
}

export type RuntimeSource = () => ApiRuntime;

/**
 * The sender wired until WP-15 supplies the real one. In production it refuses, so invite creation fails
 * (and the invite is cancelled) instead of returning 201 for an email that was never sent (Q-081). Elsewhere
 * it only logs, without the token or address.
 */
export function createUnconfiguredInviteSender(
  env: { NODE_ENV?: string | undefined },
  log: { warn(msg: string): void },
): InviteSender {
  return {
    async send() {
      if (env.NODE_ENV === "production") {
        throw new Error("No invite email sender is configured (WP-15).");
      }
      log.warn("invite created but no email sender is configured (WP-15)");
    },
  };
}
