// email.fetch + email.redact (BACKEND_PLAN §7.8.2): the raw message through the worker-only provider path, MIME and PDF
// to REDACTED text in the parsing sandbox. The body exists only in the returned object's `text`, handed straight to the
// model call and then dropped; nothing here stores or logs it (hard rules 7 and 8). What outlives the call is the
// `PreparedSummary`: signals, never text.
import { Temporal } from "@js-temporal/polyfill";
import { householdToday } from "@mp/db";
import { prepareEmail } from "@mp/email";
import { ProviderError, type MailProvider, type MailProviderId } from "@mp/email/providers";
import type { PendingMessage } from "./repo";
import type { PreparedSummary } from "./analyze";

/**
 * Which Authentication-Results header counts (Q-062, S4): only one that is confidently OUR receiving system's own, never
 * one a sender could have planted. If the policy is not met the message is simply unauthenticated and goes to review.
 *   Gmail    the top-most header, with authserv-id `mx.google.com`.
 *   Outlook  the top-most header, which Exchange Online writes without a leading authserv-id and with its own
 *            `compauth=` composite verdict; a header without it is not Exchange's.
 * Both are assumptions about real messages that no fixture of a real message has confirmed yet (Q-237).
 */
export const AUTHENTICATION_POLICY: Readonly<
  Record<
    MailProviderId,
    { trustedAuthservIds: string[]; authenticationPolicy: { topmostOnly: true; requireTokens?: string[] } }
  >
> = {
  gmail: { trustedAuthservIds: ["mx.google.com"], authenticationPolicy: { topmostOnly: true } },
  outlook: {
    trustedAuthservIds: [],
    authenticationPolicy: { topmostOnly: true, requireTokens: ["compauth="] },
  },
};

export type ReadResult =
  | {
      kind: "ok";
      /** Redacted, at most 20k characters. Goes to the model call and nowhere else. */
      text: string;
      /** The day the message arrived, in the household's own calendar. */
      receivedAt: Temporal.PlainDate;
      prepared: PreparedSummary;
    }
  /** The provider no longer has the message (deleted, or moved out of reach). */
  | { kind: "gone" }
  /** Too large, malformed, over a parsing limit (`parse_limit`) or empty: nothing to extract. */
  | { kind: "unreadable"; reason: "too_large" | "malformed" | "empty" | "parse_limit" };

export async function readMessage(
  provider: MailProvider,
  accessToken: string,
  message: Pick<PendingMessage, "providerMessageId" | "receivedAtIso">,
  timezone: string,
): Promise<ReadResult> {
  let raw: Uint8Array;
  try {
    raw = await provider.fetchRaw(accessToken, message.providerMessageId);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "not_found") return { kind: "gone" };
    throw err;
  }
  const prepared = await prepareEmail(raw, AUTHENTICATION_POLICY[provider.id]);
  if (!prepared.ok) return { kind: "unreadable", reason: prepared.reason };
  return {
    kind: "ok",
    text: prepared.text,
    receivedAt: Temporal.PlainDate.from(householdToday(message.receivedAtIso, timezone)),
    prepared: {
      senderDomain: prepared.senderDomain,
      subject: prepared.subject,
      truncated: prepared.truncated,
      authentication: prepared.authentication,
      notes: prepared.notes,
      originalSenderDomain: prepared.originalSenderDomain,
      originalSenderSource: prepared.originalSenderSource,
    },
  };
}
