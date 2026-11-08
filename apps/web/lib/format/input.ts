// Parsing what people type, and the few formats @mp/format does not cover. No floats for money.
import { Temporal } from "@js-temporal/polyfill";

/** "$1,234.5" becomes 123450. Null when it is not a plain dollar amount (no sign, at most 2 decimals). */
export function parseDollars(text: string): number | null {
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number((match[1] ?? "").replace(/,/g, ""));
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = whole * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The household-local calendar date of a UTC timestamp, as `YYYY-MM-DD`. */
export function localDate(timestamp: string, timeZone: string): string {
  return Temporal.Instant.from(timestamp).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

/** "Oct 27, 8:58 AM" in the household's time zone (the activity log). */
export function timestampLabel(timestamp: string, timeZone: string): string {
  const z = Temporal.Instant.from(timestamp).toZonedDateTimeISO(timeZone);
  const hour = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const minute = String(z.minute).padStart(2, "0");
  return `${MONTHS[z.month - 1]} ${z.day}, ${hour}:${minute} ${z.hour < 12 ? "AM" : "PM"}`;
}

/** "12 min ago", "3 hours ago", "2 days ago", between a UTC instant and `nowMs`. */
export function agoLabel(timestamp: string, nowMs: number): string {
  const minutes = Math.max(
    0,
    Math.floor((nowMs - Temporal.Instant.from(timestamp).epochMilliseconds) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
