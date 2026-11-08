// WP-05's `InviteSender` port (apps/api/src/auth/runtime.ts), implemented (Q-081): renders the invitation, links to
// `/invite?token=…` on the web app, escapes the names, and enforces a per-user send quota before it sends.
import type { EmailSender } from "./email/types";
import { renderInviteEmail, toMessage } from "./templates";

/** The same shape as the API's `InviteSender` plus the sender's user id, which the quota needs. */
export interface InviteEmail {
  to: string;
  /** The one-time secret for the link. Never log it. */
  token: string;
  householdName: string;
  inviterFirstName: string;
  /** The invitee's first name when the inviter gave one; already HTML-escaped by the API like the other names. */
  inviteeFirstName?: string;
  expiresAt: Date;
  invitedByUserId: string;
}

export interface InviteSenderPort {
  send(invite: InviteEmail): Promise<void>;
  /** Whether this user still has quota, without using any (so a caller can refuse before changing anything). */
  canSend(userId: string): Promise<boolean>;
}

/** Counts sends per user. Implementations are atomic (check and record together). */
export interface SendQuota {
  /** Records one send of `kind` for the user and returns true, or returns false when the quota is used up. */
  consume(userId: string, kind: "invite"): Promise<boolean>;
  /** True while the user has quota left. Read-only. */
  hasRoom?(userId: string, kind: "invite"): Promise<boolean>;
}

export class SendQuotaExceededError extends Error {
  override readonly name = "SendQuotaExceededError";
  constructor() {
    super("send quota exceeded");
  }
}

/** Invite emails one user may send per rolling 24 hours (BACKEND_PLAN §6: 5 invites per user per day). */
export const INVITE_DAILY_QUOTA = 5;

export interface MemoryQuotaOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

/** Per-process quota for development and tests. Production uses the database-backed one in apps/api. */
export function createMemorySendQuota(options: MemoryQuotaOptions = {}): SendQuota {
  const limit = options.limit ?? INVITE_DAILY_QUOTA;
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const events = new Map<string, number[]>();
  return {
    async consume(userId, kind) {
      const key = `${kind}:${userId}`;
      const t = now();
      const recent = (events.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        events.set(key, recent);
        return false;
      }
      recent.push(t);
      events.set(key, recent);
      return true;
    },
    async hasRoom(userId, kind) {
      const t = now();
      return (events.get(`${kind}:${userId}`) ?? []).filter((at) => t - at < windowMs).length < limit;
    },
  };
}

export interface InviteSenderOptions {
  email: EmailSender;
  quota: SendQuota;
  /** The web app origin, e.g. `https://app.moneypilot.example`; the link is `{appUrl}/invite?token=…`. */
  appUrl: string;
}

/** `{appUrl}/invite?token=…`, the token percent-encoded. */
export function inviteLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/invite?token=${encodeURIComponent(token)}`;
}

export function createInviteSender(options: InviteSenderOptions): InviteSenderPort {
  try {
    new URL(options.appUrl);
  } catch {
    throw new TypeError("appUrl must be an absolute URL.");
  }
  return {
    canSend: async (userId) => (await options.quota.hasRoom?.(userId, "invite")) ?? true,
    async send(invite) {
      if (!(await options.quota.consume(invite.invitedByUserId, "invite")))
        throw new SendQuotaExceededError();
      const rendered = renderInviteEmail({
        inviterFirstName: invite.inviterFirstName,
        householdName: invite.householdName,
        link: inviteLink(options.appUrl, invite.token),
      });
      await options.email.send(toMessage(invite.to, rendered));
    },
  };
}
