// Mailbox address helpers: the keyed hash we match on (masking is `maskEmail` in @mp/format), and the Graph
// `clientState` that names a connection and proves a notification came from a subscription we made.
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA-256 of the lower-cased address under a server secret. No plaintext address is stored. */
export function addressHash(key: Uint8Array, address: string): Buffer {
  return createHmac("sha256", key).update(address.trim().toLowerCase(), "utf8").digest();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tag(secret: Uint8Array, connectionId: string): string {
  return createHmac("sha256", secret).update(`graph-client-state:${connectionId}`).digest("base64url");
}

/** `<connection id>.<hmac>`: 36 + 1 + 43 characters, under Graph's 128 limit. */
export function graphClientState(secret: Uint8Array, connectionId: string): string {
  return `${connectionId}.${tag(secret, connectionId)}`;
}

/** The connection id inside a genuine clientState, or null. Constant-time on the tag. */
export function verifyGraphClientState(secret: Uint8Array, value: string): string | null {
  const dot = value.indexOf(".");
  if (dot !== 36) return null;
  const id = value.slice(0, dot);
  if (!UUID.test(id)) return null;
  const expected = Buffer.from(tag(secret, id));
  const given = Buffer.from(value.slice(dot + 1));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}
