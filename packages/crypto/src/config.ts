// Full key provider (seal and open) from the environment: apps/worker only.
import { chooseKey, type CryptoEnv } from "./env";
import { createKmsClient, KmsKeyProvider, type KmsClientLike } from "./kms";
import { LocalKeyProvider } from "./local";
import type { KeyProvider } from "./types";

export type { CryptoEnv } from "./env";

export interface CryptoDeps {
  /** Builds the KMS client. Default: the AWS SDK (tests inject a fake). */
  kmsClient?: (region: string | undefined) => KmsClientLike;
  /** More key ids the worker may unwrap (for example the previous key during a rotation). */
  allowedKeyIds?: readonly string[];
}

export function createKeyProvider(env: CryptoEnv, deps: CryptoDeps = {}): KeyProvider {
  const c = chooseKey(env);
  return c.kind === "kms"
    ? new KmsKeyProvider((deps.kmsClient ?? createKmsClient)(c.region), c.keyId, deps.allowedKeyIds)
    : new LocalKeyProvider(c.master);
}
