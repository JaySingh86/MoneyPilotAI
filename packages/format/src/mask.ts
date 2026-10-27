// Masking per DESIGN_SPEC §7: last 4 digits only; emails masked after 3 characters.

/** Three U+2022 bullets. */
export const MASK = "•••";

/**
 * `•••4821`. Accepts a last-4 value or a longer number (only the last 4 digits are kept).
 */
export function maskLast4(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) {
    throw new RangeError("maskLast4 needs at least 4 digits.");
  }
  return `${MASK}${digits.slice(-4)}`;
}

/**
 * `sam•••@gmail.com`: at most 3 characters of the name (local part), always hiding at least
 * one, then bullets, then the domain. `sam@x.com` → `sa•••@x.com`, `x@x.com` → `•••@x.com`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, Math.max(at, 0));
  const domain = email.slice(at + 1);
  if (at <= 0 || domain.length === 0) {
    throw new TypeError("maskEmail needs an address of the form local@domain.");
  }
  const chars = [...local];
  return `${chars.slice(0, Math.min(3, chars.length - 1)).join("")}${MASK}@${domain}`;
}
