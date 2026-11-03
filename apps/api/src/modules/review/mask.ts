// Defensive masking of the stored subject when it is read (M1). The email pipeline redacts the subject with the
// WP-19 redactor before it writes `message_meta` (WP-22 checklist); this is the second line of defense, so a
// long account or card number can never reach a partner's screen. Pure.

/** A run of 8 or more digits, optionally separated by single spaces or dashes (card-like numbers). */
const LONG_DIGITS = /\d(?:[ -]?\d){7,}/g;

export function maskSubject(subject: string | null): string | null {
  if (subject === null) return null;
  return subject.replace(LONG_DIGITS, (run) => `•••${run.replace(/\D/g, "").slice(-4)}`);
}
