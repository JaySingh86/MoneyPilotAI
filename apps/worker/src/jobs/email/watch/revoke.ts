// Job `email.revoke` (BACKEND_PLAN §7.8.1, §10, §7.11): finishes a disconnect. The API (or WP-05's leave hook) only
// marks the connection `revoked`, because it can never read the token. This job, the one place that can:
//   1. opens the sealed token and gets an access token,
//   2. stops the watch or subscription,
//   3. revokes the grant at the provider (Google does; Microsoft has no per-token revoke, which is recorded),
//   4. deletes the token (ciphertext, wrapped key, key id) and the sync state,
//   5. writes an audit event (without the address).
// Idempotent: once the token is gone there is nothing to do. The token is never deleted before the grant is revoked
// where revoking is possible: a provider that is down, a provider this worker has no settings for, or a key that
// cannot open the token all keep the ciphertext and retry (then alert), so a leaked or restored copy of the token is
// never the only thing left of a grant we claimed to have ended. Two cases delete without revoking: the grant is
// already gone (the person removed the app), and Microsoft, which has no per-token revoke (`revokedAtProvider: false`
// is recorded in the audit event and the person is told to also remove the app in their Microsoft account).
import { z } from "zod";
import { sql } from "drizzle-orm";
import { ProviderError } from "@mp/email/providers";
import { accessFor, audit, loadConnection, providerFor, type EmailJobDeps } from "../discover/connection";

export const EMAIL_REVOKE_QUEUE = "email.revoke";
export const EmailRevokeJob = z.object({ householdId: z.uuid(), connectionId: z.uuid() });
export type EmailRevokeJob = z.infer<typeof EmailRevokeJob>;
export const EMAIL_REVOKE_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 8,
  retryDelay: 30,
  retryBackoff: true,
} as const;
export const emailRevokeSingletonKey = (j: EmailRevokeJob) => `${EMAIL_REVOKE_QUEUE}:${j.connectionId}`;

export type RevokeOutcome =
  | { outcome: "skipped"; reason: "not_revoked" | "token_gone" | "gone" }
  | { outcome: "revoked"; atProvider: boolean; watchStopped: boolean };

export async function handleEmailRevoke(
  deps: EmailJobDeps,
  data: unknown,
  options: { lastAttempt?: boolean } = {},
): Promise<RevokeOutcome> {
  const job = EmailRevokeJob.parse(data);
  const { householdId } = job;
  const conn = await deps.db.withJobTx(householdId, (tx) =>
    loadConnection(tx, householdId, job.connectionId),
  );
  if (!conn) return { outcome: "skipped", reason: "gone" };
  if (conn.status !== "revoked") return { outcome: "skipped", reason: "not_revoked" };
  if (!conn.sealed) return { outcome: "skipped", reason: "token_gone" };

  let atProvider = false;
  let watchStopped = false;
  try {
    const provider = providerFor(deps, conn);
    if (!provider) throw new Error("No provider client is configured for this connection.");
    try {
      const { accessToken, refreshToken } = await accessFor(deps, conn, provider);
      try {
        await provider.stopWatch(accessToken, conn.watchRef);
        watchStopped = true;
      } catch (err) {
        // A watch that is already gone is fine; a provider outage is retried.
        if (!(err instanceof ProviderError) || err.kind === "transient" || err.kind === "rate_limited")
          throw err;
      }
      atProvider = await provider.revoke(refreshToken);
    } catch (err) {
      // The grant is already gone: the token is useless, so delete it.
      if (!(err instanceof ProviderError) || err.kind !== "auth_revoked") throw err;
    }
  } catch (err) {
    if (options.lastAttempt) {
      deps.log.error(
        { alert: "email_revoke_stuck", connectionId: conn.id, provider: conn.provider },
        "a disconnected mailbox still holds its token: it could not be revoked at the provider",
      );
    }
    // Keep the token and retry.
    throw err;
  }

  await deps.db.withJobTx(householdId, async (tx) => {
    await tx.execute(sql`update email_connections set token_ciphertext = null, token_dek_wrapped = null,
        token_key_id = null, watch_ref = null, watch_expires_at = null, sync_cursor = null, backfill_cursor = null,
        push_received_at = null
      where id = ${conn.id} and household_id = ${householdId} and status = 'revoked'`);
    await audit(tx, conn, "email.token_deleted", {
      provider: conn.provider,
      revokedAtProvider: atProvider,
      watchStopped,
    });
  });
  return { outcome: "revoked", atProvider, watchStopped };
}
