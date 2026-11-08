// Local data-key generator for development and tests: wraps a fresh data key with a 32-byte master key held in
// memory. Encrypt only (no way back to plaintext): the part of the local provider apps/api may use. The worker's
// `LocalKeyProvider` in local.ts adds unwrapping.
import { createHash, randomBytes } from "node:crypto";
import { aeadEncrypt } from "./aead";
import { DATA_KEY_BYTES, type DataKey, type DataKeyGenerator, type TokenContext } from "./types";

export class LocalDataKeyGenerator implements DataKeyGenerator {
  protected readonly master: Uint8Array;
  readonly #id: string;

  constructor(masterKey: Uint8Array) {
    if (masterKey.length !== DATA_KEY_BYTES) throw new Error("The local master key must be 32 bytes.");
    this.master = Uint8Array.from(masterKey);
    this.#id = `local:${createHash("sha256").update(masterKey).digest("hex").slice(0, 16)}`;
  }

  keyId(): string {
    return this.#id;
  }

  async generateDataKey(context: TokenContext): Promise<DataKey> {
    const plaintext = randomBytes(DATA_KEY_BYTES);
    return { plaintext, wrapped: aeadEncrypt(this.master, plaintext, context), keyId: this.#id };
  }
}
