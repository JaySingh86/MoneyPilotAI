// Email connections (BACKEND_PLAN §7.8.1, §10): start OAuth (PKCE + server-side state, step-up checked by the
// route), the callback that turns a code into a sealed refresh token, pause/resume/disconnect by the mailbox owner,
// and the two provider push webhooks. The API only ever SEALS a token (`@mp/crypto/encrypt`); it cannot read one
// back and never decrypts (hard rule 7). Only apps/worker opens it, to watch, backfill and revoke.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JWTVerifyGetKey } from "jose";
import {
  AppError,
  type EmailAuthUrl,
  type EmailConnectError,
  type EmailConnection,
  type EmailConnectionList,
  type EmailProviderId,
  type EmailReturnTo,
  type StartEmailConnectionBody,
} from "@mp/contracts";
import type { ApiContext, ApiDb, Tx } from "@mp/db";
import { sealToken, type DataKeyGenerator } from "@mp/crypto/encrypt";
import {
  ProviderError,
  addressHash,
  generatePkce,
  generateState,
  hashState,
  verifyGraphClientState,
  type OAuthClient,
} from "@mp/email/oauth";
import { maskEmail } from "@mp/format";
import { verifyGoogleOidcToken, webhookRejected } from "../../lib/webhooks";
import { recordAudit, type RequestMeta } from "../identity/audit";
import { mapDbError } from "../items/service";
import { hashNonce, newBrowserNonce } from "./cookie";
import * as repo from "./repo";

/** BACKEND_PLAN §7.8.1: the state is stored server-side for 10 minutes. */
export const STATE_TTL_MINUTES = 10;

export interface EmailDeps {
  db: ApiDb;
  /** The provider client, or null when it is not configured on this server (answers 503). */
  providers: (id: EmailProviderId) => OAuthClient | null;
  /** Seal-only view of the key provider. */
  keys: DataKeyGenerator;
  /** Secret for the keyed address hash (matches a Gmail push to its connection). */
  addressHashKey: Uint8Array;
  /** Secret for the Graph `clientState` HMAC. */
  graphStateSecret: Uint8Array;
  /** The web app's origin, where the callback sends the browser back to. */
  webOrigin: string;
  /** Pub/Sub push authentication (audience and the subscription's service account). Null: not configured. */
  gmailPush: { audience: string; serviceAccountEmail: string; jwks?: JWTVerifyGetKey } | null;
}

export interface Caller {
  ctx: ApiContext;
  userId: string;
}

const unavailable = () =>
  new AppError("internal_error", 503, "Email connections are not available right now.");
const notFound = () => new AppError("not_found", 404, "Connection not found.");

async function inTx<T>(deps: EmailDeps, ctx: ApiContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

const STATUS = { active: "connected", paused: "paused", error: "error" } as const;

export function toConnection(row: repo.ConnectionRow): EmailConnection {
  // A disconnected mailbox is never listed or returned; the queries and routes filter it out.
  if (row.status === "revoked") throw new Error("A disconnected mailbox has no connection view.");
  return {
    id: row.id,
    provider: row.provider,
    ownerUserId: row.userId,
    maskedAddress: row.addressMasked,
    status: STATUS[row.status],
    lastCheckedAt: row.lastSyncedAt,
    backfillMonths: row.backfillMonths,
    matchedCount: row.matched,
    usedCount: row.used,
  };
}

// ===== List and manage =====

export async function list(deps: EmailDeps, c: Caller, householdId: string): Promise<EmailConnectionList> {
  return inTx(deps, c.ctx, async (tx) => {
    if (!(await repo.isMember(tx, householdId))) throw new AppError("not_found", 404, "Household not found.");
    return { data: (await repo.listConnections(tx, householdId)).map(toConnection), nextCursor: null };
  });
}

/** The owner's own connection, or 404 (not visible) / 403 (a partner: they can see it, not change it). */
async function ownConnection(tx: Tx, userId: string, id: string): Promise<repo.ConnectionRow> {
  const row = await repo.getConnection(tx, id);
  if (!row) throw notFound();
  if (row.userId !== userId) {
    throw new AppError("forbidden", 403, "Only the person who connected this mailbox can change it.");
  }
  return row;
}

async function audit(tx: Tx, c: Caller, row: repo.ConnectionRow, action: string, meta: RequestMeta) {
  await recordAudit(tx, {
    householdId: row.householdId,
    actorUserId: c.userId,
    action,
    entityType: "email_connection",
    entityId: row.id,
    metadata: { provider: row.provider },
    meta,
  });
}

export async function pause(
  deps: EmailDeps,
  c: Caller,
  id: string,
  meta: RequestMeta,
): Promise<EmailConnection> {
  return inTx(deps, c.ctx, async (tx) => {
    const row = await ownConnection(tx, c.userId, id);
    if (row.status === "revoked") throw notFound();
    if (row.status !== "active") throw new AppError("conflict", 409, "This connection is not running.");
    await repo.setStatus(tx, id, ["active"], "paused");
    await audit(tx, c, row, "email.paused", meta);
    return toConnection({ ...row, status: "paused" });
  });
}

export async function resume(
  deps: EmailDeps,
  c: Caller,
  id: string,
  meta: RequestMeta,
): Promise<EmailConnection> {
  return inTx(deps, c.ctx, async (tx) => {
    const row = await ownConnection(tx, c.userId, id);
    if (row.status === "revoked") throw notFound();
    if (row.status === "active") return toConnection(row);
    await repo.setStatus(tx, id, ["paused", "error"], "active");
    await audit(tx, c, row, "email.resumed", meta);
    return toConnection({ ...row, status: "active" });
  });
}

/**
 * Marks the connection disconnected and records who asked. The worker (job `email.revoke`) then revokes at the
 * provider, stops the watch and deletes the token, because only the worker can read it. Idempotent.
 */
export async function disconnect(deps: EmailDeps, c: Caller, id: string, meta: RequestMeta): Promise<void> {
  await inTx(deps, c.ctx, async (tx) => {
    const row = await ownConnection(tx, c.userId, id);
    if (row.status === "revoked") return;
    await repo.setStatus(tx, id, ["active", "paused", "error"], "revoked");
    await audit(tx, c, row, "email.disconnected", meta);
  });
}

// ===== OAuth =====

export async function start(
  deps: EmailDeps,
  c: Caller,
  providerId: EmailProviderId,
  body: StartEmailConnectionBody,
): Promise<EmailAuthUrl & { browserNonce: string }> {
  const provider = deps.providers(providerId);
  if (!provider) throw unavailable();
  const pkce = generatePkce();
  const state = generateState();
  // Ties the round trip to this browser: the route puts the nonce in a cookie, the callback must send it back.
  const browserNonce = newBrowserNonce();
  await inTx(deps, c.ctx, async (tx) => {
    if ((await repo.currentHouseholdId(tx)) === null) {
      throw new AppError("conflict", 409, "Create or join a household before connecting a mailbox.");
    }
    await repo.insertState(
      tx,
      {
        stateHash: hashState(state),
        browserHash: hashNonce(browserNonce),
        userId: c.userId,
        provider: providerId,
        returnTo: body.returnTo,
        verifier: pkce.verifier,
      },
      STATE_TTL_MINUTES,
    );
  });
  return { authUrl: provider.authorizationUrl({ state, codeChallenge: pkce.challenge }), browserNonce };
}

export interface CallbackQuery {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

const DEFAULT_RETURN: EmailReturnTo = "/imports";

function redirect(deps: EmailDeps, returnTo: EmailReturnTo, query: Record<string, string>): string {
  const url = new URL(returnTo, deps.webOrigin);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function failureCode(err: unknown): EmailConnectError {
  if (err instanceof ProviderError) {
    if (err.kind === "auth_revoked") return "exchange_failed";
    if (err.kind === "permanent") return "scope_missing";
  }
  return "unavailable";
}

/**
 * The browser redirect from the provider. It carries no sign-in, only the state, which is looked up and deleted
 * in one step (works once, within 10 minutes) and names who started it. Always answers with a URL to redirect
 * the browser to: `{returnTo}?connected=<provider>` or `?connect_error=<code>`; nothing is stored on a failure.
 */
export async function callback(
  deps: EmailDeps,
  providerId: EmailProviderId,
  query: CallbackQuery,
  meta: RequestMeta,
  /** The nonce from the cookie `start` set in the browser; undefined when the cookie did not come back. */
  browserNonce: string | undefined,
): Promise<string> {
  const fail = (code: EmailConnectError, returnTo: EmailReturnTo = DEFAULT_RETURN) =>
    redirect(deps, returnTo, { connect_error: code });

  const provider = deps.providers(providerId);
  if (!query.state) return fail("invalid_state");
  let consumed: repo.ConsumedState | undefined;
  try {
    consumed = await deps.db.withHouseholdTx({ userId: null }, (tx) =>
      repo.consumeState(tx, hashState(query.state ?? ""), browserNonce ? hashNonce(browserNonce) : null),
    );
  } catch {
    return fail("unavailable");
  }
  if (!consumed || consumed.provider !== providerId) return fail("invalid_state");
  const { returnTo } = consumed;
  if (!provider) return fail("unavailable", returnTo);
  if (query.error !== undefined || !query.code) return fail("access_denied", returnTo);
  if (!consumed.householdId) return fail("no_household", returnTo);
  const householdId = consumed.householdId;

  let grant;
  try {
    grant = await provider.exchangeCode({ code: query.code, codeVerifier: consumed.verifier });
  } catch (err) {
    return fail(failureCode(err), returnTo);
  }

  const connectionId = randomUUID();
  try {
    const sealed = await sealToken(deps.keys, grant.refreshToken, { connectionId });
    await deps.db.withHouseholdTx({ userId: consumed.userId, householdId }, async (tx) => {
      await repo.insertConnection(tx, {
        id: connectionId,
        householdId,
        userId: consumed.userId,
        provider: providerId,
        addressMasked: maskEmail(grant.address),
        addressHash: addressHash(deps.addressHashKey, grant.address),
        scopes: grant.scopes,
        ciphertext: sealed.ciphertext,
        dekWrapped: sealed.dekWrapped,
        keyId: sealed.keyId,
      });
      await recordAudit(tx, {
        householdId,
        actorUserId: consumed.userId,
        action: "email.connected",
        entityType: "email_connection",
        entityId: connectionId,
        metadata: { provider: providerId },
        meta,
      });
    });
  } catch (err) {
    // A second connection of the same mailbox by the same member hits the unique index. The live connection holds
    // a grant for the same app and person, and Google revokes the whole grant when any of its tokens is revoked, so
    // revoking here would break the connection that works. For every other failure the new grant is ours alone and
    // nothing stores it: revoke it, so no grant lives at the provider that we cannot use or disconnect.
    if (isUniqueViolation(err)) return fail("already_connected", returnTo);
    await provider.revoke(grant.refreshToken).catch(() => false);
    return fail("unavailable", returnTo);
  }
  return redirect(deps, returnTo, { connected: providerId });
}

// ===== Provider pushes =====
// The payload is never trusted beyond routing: a verified push only marks the connection, and the worker re-reads
// the mailbox through history/delta.

const GmailPush = z.object({
  message: z.object({ data: z.string().min(1).max(4096), messageId: z.string().max(200).optional() }),
});
const GmailPushData = z.object({ emailAddress: z.string().min(3).max(320) });

export async function receiveGmailPush(
  deps: EmailDeps,
  authorization: string | undefined,
  body: unknown,
): Promise<{ status: "queued" | "ignored" }> {
  if (!deps.gmailPush) throw unavailable();
  await verifyGoogleOidcToken(authorization, deps.gmailPush);
  const parsed = GmailPush.safeParse(body);
  if (!parsed.success) throw new AppError("validation_failed", 400, "The push message is malformed.");
  let address: string;
  try {
    const data = GmailPushData.parse(
      JSON.parse(Buffer.from(parsed.data.message.data, "base64").toString("utf8")),
    );
    address = data.emailAddress;
  } catch {
    throw new AppError("validation_failed", 400, "The push message is malformed.");
  }
  const marked = await deps.db.withHouseholdTx({ userId: null }, (tx) =>
    repo.pushGmail(tx, addressHash(deps.addressHashKey, address)),
  );
  return { status: marked > 0 ? "queued" : "ignored" };
}

const GraphNotifications = z.object({
  value: z
    .array(z.object({ clientState: z.string().max(200) }).passthrough())
    .min(1)
    .max(100),
});

export async function receiveGraphPush(
  deps: EmailDeps,
  body: unknown,
): Promise<{ status: "queued" | "ignored" }> {
  if (!deps.providers("outlook")) throw unavailable();
  const parsed = GraphNotifications.safeParse(body);
  if (!parsed.success) throw webhookRejected("The Graph request has no notifications.");
  const ids = new Set<string>();
  for (const n of parsed.data.value) {
    const id = verifyGraphClientState(deps.graphStateSecret, n.clientState);
    if (!id) throw webhookRejected("The Graph clientState does not match.");
    ids.add(id);
  }
  let marked = 0;
  for (const id of ids) {
    marked += await deps.db.withHouseholdTx({ userId: null }, (tx) => repo.pushGraph(tx, id));
  }
  return { status: marked > 0 ? "queued" : "ignored" };
}
