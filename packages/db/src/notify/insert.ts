// In-app notifications written by the API in the same transaction as the action that causes them (a proposal
// created or decided, a partner accepting an invite). The dispatcher (apps/worker) mails the person if their
// preferences allow it. WP-15; BACKEND_PLAN §7.6.
//
// `title` and `body` are plain text and may carry a first name or a household name: the email templates and the
// web app escape on output, and nothing here goes into a job payload (jobs carry ids only).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NotificationKind } from "../schema/notify";
import type { Tx } from "../tx";

export interface NewNotification {
  householdId: string;
  /** The recipient: an active or former member of the household. */
  userId: string;
  /** Kinds mp_api may write: proposal, task, review, system. */
  kind: Extract<NotificationKind, "proposal" | "task" | "review" | "system">;
  /** Same key, same notification: a retry or a double click adds nothing. */
  dedupeKey: string;
  title: string;
  body: string;
  /** App-relative, e.g. `/goals`. */
  deepLink?: string | null;
}

/** Postgres unique_violation, looking through driver/ORM wrappers. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Returns true when a row was added, false when the dedupe key already existed.
 *
 * Not `ON CONFLICT DO NOTHING`: that makes Postgres check the new row against the SELECT policy too, and a
 * member may only read their OWN notifications, so a row for the other member would be refused. A savepoint
 * around a plain insert gives the same "once per key" result.
 */
export async function insertNotification(tx: Tx, n: NewNotification): Promise<boolean> {
  try {
    // No RETURNING, for the same reason: a member cannot read another member's notification back.
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql`insert into notifications
          (id, household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at)
        values (${randomUUID()}, ${n.householdId}, ${n.userId}, ${n.kind}, ${n.dedupeKey}, ${n.title}, ${n.body},
          ${n.deepLink ?? null}, now())`);
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export interface InviteAcceptedNotice {
  householdId: string;
  /** sha256 of the invite token, the way `invites.token_hash` stores it. */
  tokenHash: Buffer;
  /** The person who just accepted (the caller). */
  accepterUserId: string;
}

/**
 * `invite.accepted` (BACKEND_PLAN §6 step 3, Q-087): tells whoever sent the invite that their partner joined.
 * Runs after `app_accept_invite` in the same transaction, when the accepter is already a member. Returns false
 * when there is nothing to tell (no such invite, or the sender is the accepter).
 */
export async function notifyInviteAccepted(tx: Tx, n: InviteAcceptedNotice): Promise<boolean> {
  const res = await tx.execute<{
    id: string;
    invited_by: string;
    first_name: string;
    household_name: string;
  }>(
    sql`select i.id, i.invited_by, u.first_name, h.name as household_name
          from invites i
          join users u on u.id = ${n.accepterUserId}
          join households h on h.id = i.household_id
         where i.token_hash = ${n.tokenHash} and i.household_id = ${n.householdId}`,
  );
  const row = res.rows[0];
  if (!row || row.invited_by === n.accepterUserId) return false;
  return insertNotification(tx, {
    householdId: n.householdId,
    userId: row.invited_by,
    kind: "system",
    dedupeKey: `invite.accepted:${row.id}`,
    title: `${row.first_name} joined ${row.household_name}`,
    body: "Your invitation was accepted. You can now share bills, goals and decisions.",
    deepLink: "/privacy",
  });
}
