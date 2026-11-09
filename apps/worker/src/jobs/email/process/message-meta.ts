// What the review card shows as "where it came from": sender domain, subject, arrival time. Nothing else, ever
// (the table's check constraint allows exactly these keys). The subject goes through the WP-19 redactor here, before
// anything is written, even though `prepareEmail` already redacted it once: a card is the only place a subject lives,
// and the API masks digit runs again on the way out (M1). Hard rule 7: no body, no full account number.
import { Temporal } from "@js-temporal/polyfill";
import { redact } from "@mp/email";

export const MAX_SUBJECT_CHARS = 300;

export interface MessageMeta {
  fromDomain: string;
  subject: string | null;
  /** UTC instant, ISO 8601 with `Z` (the contract's `Timestamp`). */
  receivedAt: string;
}

export function redactedSubject(subject: string, senderDomain: string | null): string | null {
  const text = redact(subject, { senderDomain }).text.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);
  return text === "" ? null : text;
}

export function messageMeta(input: {
  fromDomain: string;
  subject: string;
  receivedAtIso: string;
}): MessageMeta {
  return {
    fromDomain: input.fromDomain.slice(0, 253),
    subject: redactedSubject(input.subject, input.fromDomain),
    receivedAt: Temporal.Instant.from(input.receivedAtIso).toString({ smallestUnit: "second" }),
  };
}
