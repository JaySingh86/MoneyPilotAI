// Encrypt-only entry point: the one part of packages/crypto that apps/api may import (seals OAuth tokens at the
// callback). Its dependency graph contains no decrypt code (hard rule 7); a dependency-cruiser rule keeps it so.
export { createDataKeyGenerator, type EncryptDeps } from "./encrypt-config";
export type { CryptoEnv } from "./env";
export { sealToken } from "./seal";
export type { DataKey, DataKeyGenerator, SealedToken, TokenContext } from "./types";
