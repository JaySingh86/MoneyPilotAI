// Seal-only key provider from the environment: the one factory apps/api uses. The object has no decrypt method and the
// modules behind it contain no decrypt code.
import { createKmsGenerateClient, KmsDataKeyGenerator, type KmsGenerateClientLike } from "./kms-generate";
import { chooseKey, type CryptoEnv } from "./env";
import { LocalDataKeyGenerator } from "./local-generator";
import type { DataKeyGenerator } from "./types";

export interface EncryptDeps {
  /** Builds the KMS client. Default: the AWS SDK (tests inject a fake). */
  kmsClient?: (region: string | undefined) => KmsGenerateClientLike;
}

export function createDataKeyGenerator(env: CryptoEnv, deps: EncryptDeps = {}): DataKeyGenerator {
  const c = chooseKey(env);
  const source: DataKeyGenerator =
    c.kind === "kms"
      ? new KmsDataKeyGenerator((deps.kmsClient ?? createKmsGenerateClient)(c.region), c.keyId)
      : new LocalDataKeyGenerator(c.master);
  return {
    keyId: () => source.keyId(),
    generateDataKey: (context) => source.generateDataKey(context),
  };
}
