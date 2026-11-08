// Opens a sealed token. Worker only (hard rule 7): apps/api must not import this file or the package root;
// a test in apps/api keeps it so.
import { aeadDecrypt } from "./aead-decrypt";
import type { KeyProvider, SealedToken, TokenContext } from "./types";

export async function openToken(
  provider: KeyProvider,
  sealed: SealedToken,
  context: TokenContext,
): Promise<string> {
  const key = await provider.decryptDataKey(sealed.dekWrapped, sealed.keyId, context);
  try {
    return Buffer.from(aeadDecrypt(key, sealed.ciphertext, context)).toString("utf8");
  } finally {
    key.fill(0);
  }
}
