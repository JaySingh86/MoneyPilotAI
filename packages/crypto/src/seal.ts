// Seals a token: a fresh data key, AES-256-GCM, the data key wrapped by the master key. The plaintext data key
// is zeroed after use. This file is the only crypto the API may import (via `@mp/crypto/encrypt`).
import { aeadEncrypt } from "./aead";
import type { DataKeyGenerator, SealedToken, TokenContext } from "./types";

export async function sealToken(
  generator: DataKeyGenerator,
  plaintext: string,
  context: TokenContext,
): Promise<SealedToken> {
  if (plaintext.length === 0) throw new Error("There is nothing to seal.");
  const key = await generator.generateDataKey(context);
  try {
    return {
      ciphertext: aeadEncrypt(key.plaintext, Buffer.from(plaintext, "utf8"), context),
      dekWrapped: key.wrapped,
      keyId: key.keyId,
    };
  } finally {
    key.plaintext.fill(0);
  }
}
