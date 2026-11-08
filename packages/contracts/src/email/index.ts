// Email connections (WP-21; BACKEND_PLAN §7.8.1, §8.2). A member connects their own mailbox through OAuth in
// the browser: `start` returns the provider URL, the provider redirects to the API callback, and the callback
// sends the browser back to the web app at `{returnTo}?connected=<provider>` or `?connect_error=<code>`.
// Tokens never appear in any contract: the list shows a masked address and a status only.
import { z } from "zod";
import { page, Timestamp, Uuid } from "../common";

export const EMAIL_PROVIDER_IDS = ["gmail", "outlook"] as const;
export const EmailProviderId = z.enum(EMAIL_PROVIDER_IDS).meta({ id: "EmailProviderId" });
export type EmailProviderId = z.infer<typeof EmailProviderId>;

/**
 * Where the browser returns after the provider's consent screen. A closed list, never a URL, so the callback
 * cannot be made to redirect anywhere else. Email & imports and household setup are the two places that connect.
 */
export const EMAIL_RETURN_TO = ["/imports", "/setup"] as const;
export const EmailReturnTo = z.enum(EMAIL_RETURN_TO).meta({ id: "EmailReturnTo" });
export type EmailReturnTo = z.infer<typeof EmailReturnTo>;

/** `?connect_error=` values on the redirect back to the web app. */
export const EMAIL_CONNECT_ERRORS = [
  /** The person declined or closed the consent screen. */
  "access_denied",
  /** The state is unknown, used twice or older than 10 minutes. Start again. */
  "invalid_state",
  /** The provider refused the code. */
  "exchange_failed",
  /** The person did not grant read access to the mailbox. */
  "scope_missing",
  /** This mailbox is already connected. */
  "already_connected",
  /** The person is no longer in a household. */
  "no_household",
  /** Anything else; nothing was stored. */
  "unavailable",
] as const;
export const EmailConnectError = z.enum(EMAIL_CONNECT_ERRORS).meta({ id: "EmailConnectError" });
export type EmailConnectError = z.infer<typeof EmailConnectError>;

export const EmailProviderParams = z.object({ provider: EmailProviderId });
export const EmailConnectionParams = z.object({ id: Uuid });

/** `POST /email-connections/:provider/start`. Needs a recent second-factor sign-in (step-up, ADR-018). */
export const StartEmailConnectionBody = z
  .object({ returnTo: EmailReturnTo })
  .strict()
  .meta({ id: "StartEmailConnectionBody" });
export type StartEmailConnectionBody = z.infer<typeof StartEmailConnectionBody>;

/** The provider's consent URL, with PKCE and a server-side state. One use: it is never stored for replay. */
export const EmailAuthUrl = z.object({ authUrl: z.url() }).meta({ id: "EmailAuthUrl" });
export type EmailAuthUrl = z.infer<typeof EmailAuthUrl>;

/** What the provider appends when it redirects to the callback. Parsed leniently; the state is what matters. */
export const EmailCallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

/** `connected` is a healthy `active` connection; `error` needs the owner to reconnect. */
export const EmailConnectionStatus = z
  .enum(["connected", "paused", "error"])
  .meta({ id: "EmailConnectionStatus" });
export type EmailConnectionStatus = z.infer<typeof EmailConnectionStatus>;

export const EmailConnection = z
  .object({
    id: Uuid,
    provider: EmailProviderId,
    /** The member who connected it; only they can pause, resume or disconnect it. */
    ownerUserId: Uuid,
    /** At most 3 characters of the name, e.g. `sam•••@gmail.com`. The full address is never stored. */
    maskedAddress: z.string(),
    status: EmailConnectionStatus,
    /** Last successful check for new mail; null before the first. */
    lastCheckedAt: Timestamp.nullable(),
    /** Months the first scan covers (13 by default, so yearly renewals are found). */
    backfillMonths: z.number().int().min(1).max(24),
    /** Emails that looked like bills, statements or renewals. */
    matchedCount: z.number().int().min(0),
    /** Emails that produced an item or a change. */
    usedCount: z.number().int().min(0),
  })
  .meta({ id: "EmailConnection" });
export type EmailConnection = z.infer<typeof EmailConnection>;

/** `{ data, nextCursor }` like every list (BACKEND_PLAN §8.1). A household has a handful, so `nextCursor` is always null. */
export const EmailConnectionList = page(EmailConnection).meta({ id: "EmailConnectionList" });
export type EmailConnectionList = z.infer<typeof EmailConnectionList>;
