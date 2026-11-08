// Which key provider the environment asks for. Pure validation, no provider is built here, so the seal-only entry
// point can use it without reaching any decrypt code.
import { DATA_KEY_BYTES } from "./types";

export interface CryptoEnv {
  NODE_ENV?: string | undefined;
  TOKEN_MASTER_KEY?: string | undefined;
  KMS_TOKEN_KEY_ID?: string | undefined;
  AWS_REGION?: string | undefined;
}

export type KeyChoice =
  { kind: "kms"; keyId: string; region: string | undefined } | { kind: "local"; master: Buffer };

/**
 * The local key exists for development and tests only: it is accepted when NODE_ENV is exactly `development` or
 * `test`. Anywhere else (production, staging, or NODE_ENV unset or misspelled) KMS_TOKEN_KEY_ID is required and
 * TOKEN_MASTER_KEY must not be set.
 */
export function chooseKey(env: CryptoEnv): KeyChoice {
  const local = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  if (!local) {
    if (env.TOKEN_MASTER_KEY) {
      throw new Error(
        "TOKEN_MASTER_KEY is only accepted when NODE_ENV is development or test; it must not be set in production.",
      );
    }
    if (!env.KMS_TOKEN_KEY_ID) throw new Error("KMS_TOKEN_KEY_ID is required outside development and test.");
    return { kind: "kms", keyId: env.KMS_TOKEN_KEY_ID, region: env.AWS_REGION };
  }
  if (env.KMS_TOKEN_KEY_ID) return { kind: "kms", keyId: env.KMS_TOKEN_KEY_ID, region: env.AWS_REGION };
  const raw = env.TOKEN_MASTER_KEY;
  if (!raw) throw new Error("Set TOKEN_MASTER_KEY (base64, 32 bytes) or KMS_TOKEN_KEY_ID.");
  const master = Buffer.from(raw, "base64");
  if (master.length !== DATA_KEY_BYTES) throw new Error("TOKEN_MASTER_KEY must decode to 32 bytes.");
  return { kind: "local", master };
}
