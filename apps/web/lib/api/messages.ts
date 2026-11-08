// Friendly copy for API failures the WP-23 screens branch on (BACKEND_PLAN §8.1: clients branch on `code`).
import { ApiError } from "./client";

export function problemMessage(error: unknown, fallback: string, partnerName = "your partner"): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "approval_required":
        return `This is on ${partnerName}’s item. Ask ${partnerName} to approve it.`;
      case "mfa_required":
        return "This needs 2-step verification. Turn it on in your account, then try again.";
      case "rate_limited":
        return "You can send 5 invites a day. Try again tomorrow.";
      case "forbidden":
        return "Only the person who owns this can do that.";
    }
  }
  return fallback;
}

export function isCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}
