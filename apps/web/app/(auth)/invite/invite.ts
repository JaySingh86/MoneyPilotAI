// The invite link is `/invite?token=…` (WP-15 email). The token is a secret: it is read once from the query, held
// in memory, sent only to `POST /invites/accept`, and never logged or put into an error message.
import { ApiError } from "../../../lib/api/client";

/** 32 random bytes, base64url without padding (the WP-05 contract's `INVITE_TOKEN_PATTERN`). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function readInviteToken(search: string): string | null {
  const token = new URLSearchParams(search).get("token");
  return token !== null && TOKEN.test(token) ? token : null;
}

const STORAGE_KEY = "mp.invite";

/**
 * Keeps the token for the tab only, so it survives the Google redirect (which returns to /sign-in) while the URL
 * itself is cleaned. Cleared after the invite is accepted or refused for good.
 */
export function rememberInviteToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private mode: the token lives in memory for this page only.
  }
}

export function recallInviteToken(): string | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored !== null && TOKEN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function forgetInviteToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

export interface InviteProblem {
  title: string;
  message: string;
  /** What to offer next. */
  next: "overview" | "sign_out" | "none";
  /** The invitation can never be accepted: the stored token is cleared. */
  final: boolean;
}

/**
 * Friendly copy for a refused accept (WP-05). It switches on the problem's stable `reason`, never on `detail` text.
 * The wrong-email problem's detail carries a masked address, which is shown as the API wrote it.
 */
export function inviteProblem(error: unknown): InviteProblem {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return {
        title: "We can’t find that invitation.",
        message: "The link may be incomplete. Ask your partner to send a new invitation.",
        next: "none",
        final: true,
      };
    switch (error.reason) {
      case "wrong_email":
        return {
          title: "This invitation was sent to a different email address.",
          message: error.message,
          next: "sign_out",
          final: false,
        };
      case "expired":
        return {
          title: "This invitation has expired.",
          message: "Invitations work for 7 days. Ask your partner to send a new one.",
          next: "none",
          final: true,
        };
      case "revoked":
        return {
          title: "This invitation was cancelled.",
          message: "Ask your partner to send a new one.",
          next: "none",
          final: true,
        };
      case "used":
        return {
          title: "This invitation was already used.",
          message: "If that was you, you’re in. Otherwise ask your partner to send a new one.",
          next: "overview",
          final: true,
        };
      case "full":
        return {
          title: "This household is full.",
          message: "A household has room for two adults. Ask your partner to check who is in it.",
          next: "none",
          final: true,
        };
      case "in_other_household":
        return {
          title: "You’re already in a household.",
          message: "Leave it first in Members & privacy, then open this invitation again.",
          next: "overview",
          final: false,
        };
      case "already_member":
        return {
          title: "You’re already in this household.",
          message: "Nothing more to do.",
          next: "overview",
          final: true,
        };
      case "deleting":
        return {
          title: "This household is being deleted.",
          message: "It can’t take new members right now.",
          next: "none",
          final: true,
        };
    }
  }
  return {
    title: "We couldn’t accept the invitation.",
    message: "Nothing was changed. Check your connection and try again.",
    next: "none",
    final: false,
  };
}
