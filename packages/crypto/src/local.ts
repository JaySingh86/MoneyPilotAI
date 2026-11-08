// Local key provider for development and tests (worker side): the generator plus unwrapping. It must never run
// outside development and test (`createKeyProvider` refuses it).
import { aeadDecrypt } from "./aead-decrypt";
import { LocalDataKeyGenerator } from "./local-generator";
import type { KeyProvider, TokenContext } from "./types";

export class LocalKeyProvider extends LocalDataKeyGenerator implements KeyProvider {
  async decryptDataKey(wrapped: Uint8Array, keyId: string, context: TokenContext): Promise<Uint8Array> {
    if (keyId !== this.keyId()) throw new Error("The data key was wrapped by an unknown master key.");
    return aeadDecrypt(this.master, wrapped, context);
  }
}
