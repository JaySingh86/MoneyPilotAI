// AES-256-GCM encryption with a version byte: 0x01 | iv(12) | tag(16) | ciphertext. The AAD is the canonical context.
// Encrypt only: apps/api reaches this file; the decrypt half lives in aead-decrypt.ts (worker only).
import { createCipheriv, randomBytes } from "node:crypto";
import { DATA_KEY_BYTES, contextEntries, type TokenContext } from "./types";

export const VERSION = 1;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export function aad(context: TokenContext): Buffer {
  return Buffer.from(JSON.stringify(contextEntries(context)), "utf8");
}

export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, context: TokenContext): Uint8Array {
  if (key.length !== DATA_KEY_BYTES) throw new Error("The encryption key must be 32 bytes.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}
