// Envelope encryption for OAuth tokens (WP-21). Worker-side entry point: seal and open. apps/api imports
// `@mp/crypto/encrypt` only.
export const PACKAGE = "@mp/crypto";
export { createKeyProvider, type CryptoDeps, type CryptoEnv } from "./config";
export { createDataKeyGenerator } from "./encrypt-config";
export { createKmsClient, KmsKeyProvider, type KmsClientLike } from "./kms";
export { KmsDataKeyGenerator } from "./kms-generate";
export { LocalKeyProvider } from "./local";
export { openToken } from "./open";
export { sealToken } from "./seal";
export type { DataKey, DataKeyGenerator, KeyProvider, SealedToken, TokenContext } from "./types";
