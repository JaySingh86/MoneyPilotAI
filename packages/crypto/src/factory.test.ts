import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDataKeyGenerator } from "./encrypt";
import { createKeyProvider } from "./index";

const MASTER = randomBytes(32).toString("base64");

describe("key provider configuration", () => {
  it("uses the local provider in development when a master key is set", () => {
    const provider = createKeyProvider({ NODE_ENV: "development", TOKEN_MASTER_KEY: MASTER });
    expect(provider.keyId().startsWith("local:")).toBe(true);
  });

  it("refuses the local provider in production", () => {
    expect(() => createKeyProvider({ NODE_ENV: "production", TOKEN_MASTER_KEY: MASTER })).toThrow(
      /production/,
    );
    expect(() => createDataKeyGenerator({ NODE_ENV: "production", TOKEN_MASTER_KEY: MASTER })).toThrow(
      /production/,
    );
  });

  it("accepts the local key only when NODE_ENV is exactly development or test (S2)", () => {
    for (const NODE_ENV of ["staging", "prod", "Production", "", undefined, "production"]) {
      const env = { NODE_ENV, TOKEN_MASTER_KEY: MASTER };
      expect(() => createKeyProvider(env), String(NODE_ENV)).toThrow(/NODE_ENV is development or test/);
      expect(() => createDataKeyGenerator(env), String(NODE_ENV)).toThrow(/NODE_ENV is development or test/);
      expect(() => createKeyProvider({ NODE_ENV }), String(NODE_ENV)).toThrow(/KMS_TOKEN_KEY_ID is required/);
    }
    expect(() => createKeyProvider({ NODE_ENV: "test", TOKEN_MASTER_KEY: MASTER })).not.toThrow();
  });

  it("seal-only KMS generator uses a generate-only client", () => {
    const sent: string[] = [];
    const generator = createDataKeyGenerator(
      { NODE_ENV: "production", KMS_TOKEN_KEY_ID: "alias/mp-tokens" },
      { kmsClient: () => ({ send: async (c) => (sent.push(c.constructor.name), {}) }) },
    );
    expect(generator.keyId()).toBe("alias/mp-tokens");
    expect(Object.keys(generator).sort()).toEqual(["generateDataKey", "keyId"]);
  });

  it("refuses to start without any key", () => {
    expect(() => createKeyProvider({ NODE_ENV: "development" })).toThrow();
    expect(() => createKeyProvider({ NODE_ENV: "development", TOKEN_MASTER_KEY: "c2hvcnQ=" })).toThrow();
  });

  it("production with a KMS key id builds the KMS provider from the injected client factory", () => {
    const provider = createKeyProvider(
      { NODE_ENV: "production", KMS_TOKEN_KEY_ID: "alias/mp-tokens" },
      { kmsClient: () => ({ send: async () => ({}) }) },
    );
    expect(provider.keyId()).toBe("alias/mp-tokens");
  });

  it("the encrypt-only entry point exposes no way to decrypt", () => {
    const generator = createDataKeyGenerator({ NODE_ENV: "development", TOKEN_MASTER_KEY: MASTER });
    expect(Object.keys(generator).sort()).toEqual(["generateDataKey", "keyId"]);
  });
});
