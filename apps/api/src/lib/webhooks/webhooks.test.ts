import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { expectWebhookRejected as rejects } from "../testing";
import { constantTimeEqual, signHmac, verifyGoogleOidcToken, verifyHmacSignature } from "./index";

describe("HMAC signatures", () => {
  it("verifies hex and base64 signatures in constant time", () => {
    const sig = signHmac("s3cret", '{"a":1}');
    expect(verifyHmacSignature({ secret: "s3cret", payload: '{"a":1}', signature: sig })).toBe(true);
    expect(verifyHmacSignature({ secret: "s3cret", payload: '{"a":2}', signature: sig })).toBe(false);
    expect(verifyHmacSignature({ secret: "other", payload: '{"a":1}', signature: sig })).toBe(false);
    expect(verifyHmacSignature({ secret: "s3cret", payload: '{"a":1}', signature: sig.slice(0, 10) })).toBe(
      false,
    );
    const b64 = signHmac("s3cret", "x", "sha512", "base64");
    expect(
      verifyHmacSignature({
        secret: "s3cret",
        payload: "x",
        signature: b64,
        algorithm: "sha512",
        encoding: "base64",
      }),
    ).toBe(true);
  });

  it("matches the RFC 4231 test case 2 vector", () => {
    expect(signHmac("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("constantTimeEqual", () => {
    expect(constantTimeEqual("client-state", "client-state")).toBe(true);
    expect(constantTimeEqual("client-state", "client-statf")).toBe(false);
    expect(constantTimeEqual("short", "longer value")).toBe(false);
  });
});

describe("Google Pub/Sub push OIDC tokens", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const AUDIENCE = "https://api.moneypilot.test/webhooks/gmail";
  const SA = "gmail-push@moneypilot-dev.iam.gserviceaccount.com";
  const NOW = Date.parse("2026-10-27T15:00:00Z");
  const options = { audience: AUDIENCE, serviceAccountEmail: SA, jwks, nowMs: NOW };

  async function token(
    claims: Record<string, unknown> = {},
    opts: { iss?: string; aud?: string; exp?: number } = {},
  ) {
    return new SignJWT({ email: SA, email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? "https://accounts.google.com")
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt(Math.floor(NOW / 1000) - 10)
      .setExpirationTime(opts.exp ?? Math.floor(NOW / 1000) + 3600)
      .sign(privateKey);
  }

  it("accepts a token for our audience and service account", async () => {
    const claims = await verifyGoogleOidcToken(`Bearer ${await token()}`, options);
    expect(claims.email).toBe(SA);
  });

  it("accepts the short issuer form", async () => {
    await expect(
      verifyGoogleOidcToken(`Bearer ${await token({}, { iss: "accounts.google.com" })}`, options),
    ).resolves.toBeDefined();
  });

  it("rejects a wrong audience, issuer, service account, unverified email, expiry and missing token", async () => {
    await rejects(
      verifyGoogleOidcToken(`Bearer ${await token({}, { aud: "https://other" })}`, options),
      /invalid/,
    );
    await rejects(
      verifyGoogleOidcToken(`Bearer ${await token({}, { iss: "https://evil.example" })}`, options),
    );
    await rejects(
      verifyGoogleOidcToken(`Bearer ${await token({ email: "x@evil.iam.gserviceaccount.com" })}`, options),
      /service account/,
    );
    await rejects(
      verifyGoogleOidcToken(`Bearer ${await token({ email_verified: false })}`, options),
      /service account/,
    );
    await rejects(
      verifyGoogleOidcToken(`Bearer ${await token({}, { exp: Math.floor(NOW / 1000) - 120 })}`, options),
      /invalid/,
    );
    await rejects(verifyGoogleOidcToken(undefined, options), /no bearer token/);
    await rejects(verifyGoogleOidcToken("Basic abc", options), /no bearer token/);
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: SA, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(NOW / 1000))
      .setExpirationTime(Math.floor(NOW / 1000) + 3600)
      .sign(other.privateKey);
    await rejects(verifyGoogleOidcToken(`Bearer ${forged}`, options), /invalid/);
  });
});
