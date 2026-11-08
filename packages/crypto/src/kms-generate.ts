// AWS KMS, generate-only half (BACKEND_PLAN §10): GenerateDataKey with the connection as encryption context. This is
// all apps/api may reach; the API's task role holds `kms:GenerateDataKey` only. The client is injected, so tests never
// reach AWS; `createKmsGenerateClient` builds the real one and is only called at process start.
import { GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  DATA_KEY_BYTES,
  contextEntries,
  type DataKey,
  type DataKeyGenerator,
  type TokenContext,
} from "./types";

export interface KmsGenerateClientLike {
  send(command: GenerateDataKeyCommand): Promise<{
    Plaintext?: Uint8Array | undefined;
    CiphertextBlob?: Uint8Array | undefined;
    KeyId?: string | undefined;
  }>;
}

export function createKmsGenerateClient(region: string | undefined): KmsGenerateClientLike {
  const client = new KMSClient(region ? { region } : {});
  return { send: (command) => client.send(command) };
}

export class KmsDataKeyGenerator implements DataKeyGenerator {
  constructor(
    protected readonly generateClient: KmsGenerateClientLike,
    protected readonly keyIdValue: string,
  ) {}

  keyId(): string {
    return this.keyIdValue;
  }

  async generateDataKey(context: TokenContext): Promise<DataKey> {
    const out = await this.generateClient.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyIdValue,
        KeySpec: "AES_256",
        EncryptionContext: contextEntries(context),
      }),
    );
    if (out.Plaintext?.length !== DATA_KEY_BYTES || !out.CiphertextBlob || out.CiphertextBlob.length === 0) {
      throw new Error("KMS returned an unusable data key.");
    }
    return { plaintext: out.Plaintext, wrapped: out.CiphertextBlob, keyId: this.keyIdValue };
  }
}
