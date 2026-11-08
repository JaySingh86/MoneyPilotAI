// Envelope encryption ports (BACKEND_PLAN §10, ADR-009). A data key per connection is wrapped by a master key:
// KMS in AWS, a local key in development and tests. The wrapped key and the ciphertext are stored next to
// each other; only the worker may unwrap.

/** Authenticated context bound into the ciphertext (KMS encryption context / AES-GCM AAD). */
export interface TokenContext {
  /** `email_connections.id`, created by the API before it seals the token. */
  connectionId: string;
}

export interface DataKey {
  /** 32 random bytes. Used once, then dropped. */
  plaintext: Uint8Array;
  /** The same key wrapped by the master key. Stored as `token_dek_wrapped`. */
  wrapped: Uint8Array;
  /** Which master key wrapped it. Stored as `token_key_id`. */
  keyId: string;
}

/** What apps/api needs: make a data key. No way back to plaintext. */
export interface DataKeyGenerator {
  keyId(): string;
  generateDataKey(context: TokenContext): Promise<DataKey>;
}

/** What apps/worker needs: also unwrap. Only the worker task role may call it in AWS. */
export interface KeyProvider extends DataKeyGenerator {
  decryptDataKey(wrapped: Uint8Array, keyId: string, context: TokenContext): Promise<Uint8Array>;
}

/** The three columns `email_connections` keeps. */
export interface SealedToken {
  ciphertext: Uint8Array;
  dekWrapped: Uint8Array;
  keyId: string;
}

export const DATA_KEY_BYTES = 32;
export const TOKEN_PURPOSE = "email_connection_token";

/** Canonical form of the context for AES-GCM AAD and KMS: same keys and order everywhere. */
export function contextEntries(context: TokenContext): Record<string, string> {
  return { purpose: TOKEN_PURPOSE, connection_id: context.connectionId };
}
