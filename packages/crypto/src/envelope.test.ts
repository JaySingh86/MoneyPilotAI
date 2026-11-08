import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KmsKeyProvider, type KmsClientLike } from "./kms";
import { LocalKeyProvider } from "./local";
import { openToken } from "./open";
import { sealToken } from "./seal";

const MASTER = randomBytes(32);
const ctx = { connectionId: "11111111-1111-4111-8111-111111111111" };
const TOKEN = "1//refresh-token-value";

describe("envelope encryption with the local key provider", () => {
  const provider = new LocalKeyProvider(MASTER);

  it("round-trips and never stores the plaintext", async () => {
    const sealed = await sealToken(provider, TOKEN, ctx);
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from(TOKEN))).toBe(false);
    expect(Buffer.from(sealed.dekWrapped).includes(Buffer.from(TOKEN))).toBe(false);
    expect(sealed.keyId).toBe(provider.keyId());
    expect(await openToken(provider, sealed, ctx)).toBe(TOKEN);
  });

  it("uses a fresh data key and nonce for every token", async () => {
    const a = await sealToken(provider, TOKEN, ctx);
    const b = await sealToken(provider, TOKEN, ctx);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    expect(Buffer.from(a.dekWrapped).equals(Buffer.from(b.dekWrapped))).toBe(false);
  });

  it("is bound to the connection: another connection id cannot open it", async () => {
    const sealed = await sealToken(provider, TOKEN, ctx);
    await expect(
      openToken(provider, sealed, { connectionId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow();
  });

  it("detects tampering with the ciphertext, the wrapped key and the version", async () => {
    const sealed = await sealToken(provider, TOKEN, ctx);
    const flip = (bytes: Uint8Array, at: number) => {
      const copy = Uint8Array.from(bytes);
      copy[at] = (copy[at] ?? 0) ^ 1;
      return copy;
    };
    await expect(
      openToken(
        provider,
        { ...sealed, ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) },
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      openToken(provider, { ...sealed, ciphertext: flip(sealed.ciphertext, 0) }, ctx),
    ).rejects.toThrow();
    await expect(
      openToken(
        provider,
        { ...sealed, dekWrapped: flip(sealed.dekWrapped, sealed.dekWrapped.length - 1) },
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      openToken(provider, { ...sealed, ciphertext: sealed.ciphertext.slice(0, 10) }, ctx),
    ).rejects.toThrow();
  });

  it("a different master key cannot open it, and an unknown key id is refused", async () => {
    const sealed = await sealToken(provider, TOKEN, ctx);
    const other = new LocalKeyProvider(randomBytes(32));
    await expect(openToken(other, sealed, ctx)).rejects.toThrow();
    await expect(openToken(provider, { ...sealed, keyId: "local:ffffffffffffffff" }, ctx)).rejects.toThrow();
  });

  it("requires a 32-byte master key", () => {
    expect(() => new LocalKeyProvider(randomBytes(16))).toThrow();
  });

  it("errors never contain the token", async () => {
    const sealed = await sealToken(provider, TOKEN, ctx);
    const err = await openToken(new LocalKeyProvider(randomBytes(32)), sealed, ctx).catch((e: unknown) => e);
    expect(String(err)).not.toContain(TOKEN);
  });
});

describe("KMS key provider (injected client, no AWS)", () => {
  /** An in-memory stand-in for the AWS SDK client: wraps data keys with a fake CMK. */
  function fakeKms() {
    const local = new LocalKeyProvider(randomBytes(32));
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const client: KmsClientLike = {
      async send(command) {
        const name = command.constructor.name;
        const input = command.input as Record<string, unknown>;
        calls.push({ name, input });
        const encryptionContext = input["EncryptionContext"] as Record<string, string>;
        const keyCtx = { connectionId: encryptionContext["connection_id"] ?? "" };
        if (name === "GenerateDataKeyCommand") {
          const key = await local.generateDataKey(keyCtx);
          return { Plaintext: key.plaintext, CiphertextBlob: key.wrapped, KeyId: String(input["KeyId"]) };
        }
        if (name === "DecryptCommand") {
          const plaintext = await local.decryptDataKey(
            input["CiphertextBlob"] as Uint8Array,
            local.keyId(),
            keyCtx,
          );
          return { Plaintext: plaintext };
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    return { client, calls };
  }

  it("generates and decrypts data keys with the connection as encryption context", async () => {
    const { client, calls } = fakeKms();
    const provider = new KmsKeyProvider(client, "alias/mp-tokens");
    const sealed = await sealToken(provider, TOKEN, ctx);
    expect(sealed.keyId).toBe("alias/mp-tokens");
    expect(await openToken(provider, sealed, ctx)).toBe(TOKEN);
    expect(calls.map((c) => c.name)).toEqual(["GenerateDataKeyCommand", "DecryptCommand"]);
    expect(calls[0]?.input["KeySpec"]).toBe("AES_256");
    expect(calls[0]?.input["EncryptionContext"]).toEqual({
      purpose: "email_connection_token",
      connection_id: ctx.connectionId,
    });
  });

  it("never asks KMS to decrypt under a key id it is not configured for (S7)", async () => {
    const { client, calls } = fakeKms();
    const provider = new KmsKeyProvider(client, "alias/mp-tokens", ["alias/old"]);
    const sealed = await sealToken(provider, TOKEN, ctx);
    await expect(
      openToken(provider, { ...sealed, keyId: "arn:aws:kms:us-east-1:1:key/attacker" }, ctx),
    ).rejects.toThrow(/not configured/);
    expect(calls.map((c) => c.name)).toEqual(["GenerateDataKeyCommand"]);
    // A key on the allowlist (rotation) is still asked.
    await expect(openToken(provider, { ...sealed, keyId: "alias/old" }, ctx)).resolves.toBe(TOKEN);
  });

  it("refuses a data key of the wrong size", async () => {
    const provider = new KmsKeyProvider(
      { send: async () => ({ Plaintext: new Uint8Array(8), CiphertextBlob: new Uint8Array(8) }) },
      "alias/x",
    );
    await expect(sealToken(provider, TOKEN, ctx)).rejects.toThrow();
  });
});
