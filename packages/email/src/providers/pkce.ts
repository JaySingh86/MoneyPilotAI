// PKCE (RFC 7636) and OAuth state helpers. 256 bits from the OS random source; the state is stored hashed.
import { createHash, randomBytes } from "node:crypto";

export interface Pkce {
  /** 43 characters of base64url (32 random bytes). Kept server-side until the callback. */
  verifier: string;
  /** base64url(sha256(verifier)), sent to the provider. */
  challenge: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** The value sent to the provider and returned to the callback. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores in place of the state. */
export function hashState(state: string): Buffer {
  return createHash("sha256").update(state, "utf8").digest();
}
