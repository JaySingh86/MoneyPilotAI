// AES-256-GCM decryption, the other half of aead.ts. Worker only: nothing apps/api imports may reach this file.
import { createDecipheriv } from "node:crypto";
import { aad, IV_BYTES, TAG_BYTES, VERSION } from "./aead";
import { DATA_KEY_BYTES, type TokenContext } from "./types";

export function aeadDecrypt(key: Uint8Array, sealed: Uint8Array, context: TokenContext): Uint8Array {
  if (key.length !== DATA_KEY_BYTES) throw new Error("The encryption key must be 32 bytes.");
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
    throw new Error("The sealed value is malformed.");
  }
  const buf = Buffer.from(sealed);
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // The native message is fine, but one fixed message keeps every failure the same shape.
    throw new Error("The sealed value could not be authenticated.");
  }
}
