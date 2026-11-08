// AWS KMS provider, worker side: generate plus Decrypt (the worker's task role holds `kms:Decrypt` only). The client is
// injected, so tests never reach AWS. Before calling Decrypt the key id stored with the token must be one this process
// is configured for (`allowedKeyIds`): a row cannot make the worker ask KMS about an arbitrary key.
import { DecryptCommand, KMSClient, type GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { KmsDataKeyGenerator } from "./kms-generate";
import { DATA_KEY_BYTES, contextEntries, type KeyProvider, type TokenContext } from "./types";

/** The slice of the AWS SDK client these classes use. */
export interface KmsClientLike {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<{
    Plaintext?: Uint8Array | undefined;
    CiphertextBlob?: Uint8Array | undefined;
    KeyId?: string | undefined;
  }>;
}

/** The real SDK client. Not used in tests. */
export function createKmsClient(region: string | undefined): KmsClientLike {
  const client = new KMSClient(region ? { region } : {});
  return { send: (command) => client.send(command as GenerateDataKeyCommand) };
}

export class KmsKeyProvider extends KmsDataKeyGenerator implements KeyProvider {
  readonly #client: KmsClientLike;
  readonly #allowed: ReadonlySet<string>;

  constructor(client: KmsClientLike, keyId: string, allowedKeyIds: readonly string[] = []) {
    super(client, keyId);
    this.#client = client;
    this.#allowed = new Set([keyId, ...allowedKeyIds]);
  }

  async decryptDataKey(wrapped: Uint8Array, keyId: string, context: TokenContext): Promise<Uint8Array> {
    if (!this.#allowed.has(keyId)) {
      throw new Error("The data key names a master key this worker is not configured for.");
    }
    const out = await this.#client.send(
      new DecryptCommand({
        CiphertextBlob: wrapped,
        KeyId: keyId,
        EncryptionContext: contextEntries(context),
      }),
    );
    if (out.Plaintext?.length !== DATA_KEY_BYTES) throw new Error("KMS returned an unusable data key.");
    return out.Plaintext;
  }
}
