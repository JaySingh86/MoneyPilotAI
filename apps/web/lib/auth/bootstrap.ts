// `POST /me/bootstrap` (ADR-017): creates the user row from the verified token the first time, and on
// every later call syncs the email and MFA flag from the token's claims. The web app calls it after
// every sign-in and every token refresh so an email or MFA change shows up promptly.
import type { ApiClient } from "@mp/contracts/client";
import type { components } from "@mp/contracts/client";

export type Me = components["schemas"]["Me"];

/** The server schema caps a first name at this many characters (contracts, `BootstrapBody`). */
export const FIRST_NAME_MAX = 100;

export type BootstrapResult =
  | { kind: "ok"; me: Me }
  /** First sign-in and the token carries no first name: ask for it, then bootstrap again. */
  | { kind: "needs_name" }
  | { kind: "failed"; status: number };

export interface BootstrapHints {
  firstName: string | null;
  /** The browser's IANA zone, a hint for new accounts only (the server ignores it for existing users). */
  timezone: string | null;
}

export async function bootstrapUser(client: ApiClient, hints: BootstrapHints): Promise<BootstrapResult> {
  const body: { firstName?: string; timezone?: string } = {};
  if (hints.firstName) body.firstName = hints.firstName.trim().slice(0, FIRST_NAME_MAX);
  if (hints.timezone) body.timezone = hints.timezone;
  const { data, error, response } = await client.POST("/v1/me/bootstrap", { body });
  if (data) return { kind: "ok", me: data };
  if (response.status === 400 && error?.code === "validation_failed" && !hints.firstName) {
    return { kind: "needs_name" };
  }
  return { kind: "failed", status: response.status };
}

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
