// Token attacks against the Cognito access-token verifier (ADR-017), with a fake issuer: no network,
// no AWS credentials. Every rejection must be a 401 `unauthorized` that does not echo token contents.
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@mp/contracts";
import { createCognitoProvider } from "./cognito";
import { FakeIssuer } from "./testing/fake-issuer";
import type { AuthProvider } from "./provider";

let issuer: FakeIssuer;
let other: FakeIssuer;
let provider: AuthProvider;
const SUB = "11111111-1111-4111-8111-111111111111";
// The verifier checks exp against the real clock, so "now" is the real clock taken once at load.
const FIXED_NOW = Math.floor(Date.now() / 1000) * 1000;
const nowSeconds = Math.floor(FIXED_NOW / 1000);

beforeAll(async () => {
  issuer = await FakeIssuer.create();
  other = await FakeIssuer.create({ userPoolId: "us-east-1_OtherPool", kid: "other-key" });
  provider = createCognitoProvider(issuer.cognitoConfig(), { now: () => FIXED_NOW });
});

async function expectRejected(token: string, detail?: RegExp): Promise<AppError> {
  let caught: unknown;
  try {
    await provider.verifyToken(token);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  const err = caught as AppError;
  expect(err.status).toBe(401);
  expect(err.code).toBe("unauthorized");
  if (detail) expect(err.detail).toMatch(detail);
  return err;
}

describe("verifyToken accepts a valid Cognito access token", () => {
  it("returns the verified identity", async () => {
    const token = await issuer.accessToken(SUB, {
      nowSeconds,
      claims: { email: "sam@example.test", mfa_enabled: true },
    });
    expect(await provider.verifyToken(token)).toEqual({
      subject: SUB,
      email: "sam@example.test",
      emailVerified: true,
      mfaEnabled: true,
      mfaVerifiedAt: nowSeconds,
      expiresAt: nowSeconds + 3600,
    });
  });

  it("tolerates up to 60 seconds of clock skew on exp, no more", async () => {
    // The verifier compares against the real clock: tokens built relative to it.
    const real = Math.floor(Date.now() / 1000);
    const real_provider = createCognitoProvider(issuer.cognitoConfig());
    const recentlyExpired = await issuer.accessToken(SUB, { nowSeconds: real - 3630, lifetimeSeconds: 3600 });
    await expect(real_provider.verifyToken(recentlyExpired)).resolves.toMatchObject({ subject: SUB });
    const longExpired = await issuer.accessToken(SUB, { nowSeconds: real - 3700, lifetimeSeconds: 3600 });
    await expect(real_provider.verifyToken(longExpired)).rejects.toMatchObject({ status: 401 });
  });

  it("reads email_verified sent as a string, but never a string mfa_enabled or mfa_verified_at", async () => {
    const token = await issuer.accessToken(SUB, {
      nowSeconds,
      claims: { email_verified: "true", mfa_enabled: "true", mfa_verified_at: String(nowSeconds) },
    });
    const verified = await provider.verifyToken(token);
    expect(verified.emailVerified).toBe(true);
    expect(verified.mfaEnabled).toBeNull();
    expect(verified.mfaVerifiedAt).toBeNull();
  });

  it("does not treat a truthy non-boolean as verified", async () => {
    const token = await issuer.accessToken(SUB, { claims: { email_verified: 1, mfa_enabled: "yes" } });
    const verified = await provider.verifyToken(token);
    expect(verified.emailVerified).toBe(false);
    expect(verified.mfaEnabled).toBeNull();
  });
});

describe("token attacks", () => {
  it("rejects a token from another issuer (wrong user pool) even if the signature is valid for its own key", async () => {
    await expectRejected(await other.accessToken(SUB));
  });

  it("rejects a token claiming our issuer and kid but signed with another key", async () => {
    const attacker = await FakeIssuer.create({ kid: issuer.kid });
    await expectRejected(await attacker.accessToken(SUB));
  });

  it("rejects the wrong client id", async () => {
    await expectRejected(await issuer.accessToken(SUB, { claims: { client_id: "someone-elses-client" } }));
  });

  it("rejects a token without a client id", async () => {
    await expectRejected(await issuer.accessToken(SUB, { claims: { client_id: undefined } }));
  });

  it("rejects an ID token presented as an access token", async () => {
    await expectRejected(await issuer.idToken(SUB));
  });

  it("rejects an ID token even when it carries the right client_id", async () => {
    await expectRejected(await issuer.accessToken(SUB, { claims: { token_use: "id" } }));
  });

  it("rejects an expired token with a refresh hint", async () => {
    const real = Math.floor(Date.now() / 1000);
    const expired = await issuer.accessToken(SUB, { nowSeconds: real - 7200, lifetimeSeconds: 3600 });
    await expectRejected(expired, /expired/i);
  });

  it("rejects alg none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: issuer.kid })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: SUB,
        iss: issuer.issuer,
        client_id: issuer.clientId,
        token_use: "access",
        exp: Math.floor(Date.now() / 1000) + 3600,
        email: "a@example.test",
        email_verified: true,
      }),
    ).toString("base64url");
    await expectRejected(`${header}.${payload}.`);
    await expectRejected(`${header}.${payload}`);
  });

  it("rejects HS256 signed with the public key material as the secret (algorithm confusion)", async () => {
    const jwk = issuer.jwks.keys[0] as unknown as { n: string };
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: issuer.kid })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: SUB,
        iss: issuer.issuer,
        client_id: issuer.clientId,
        token_use: "access",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", jwk.n).update(`${header}.${payload}`).digest("base64url");
    await expectRejected(`${header}.${payload}.${signature}`);
  });

  it("rejects a token with an unknown kid without touching the network", async () => {
    await expectRejected(await issuer.accessToken(SUB, { kid: "not-in-jwks" }));
  });

  it("rejects garbage, empty and oversized input", async () => {
    await expectRejected("");
    await expectRejected("not-a-jwt");
    await expectRejected("a.b.c");
    await expectRejected(`${"a".repeat(20_000)}.b.c`);
  });

  it("never echoes the token or its claims in the error", async () => {
    const token = await issuer.accessToken(SUB, {
      claims: { client_id: "wrong", email: "leak@example.test" },
    });
    const err = await expectRejected(token);
    expect(JSON.stringify(err.toProblem())).not.toContain("leak@example.test");
    expect(JSON.stringify(err.toProblem())).not.toContain(token.slice(0, 20));
  });
});

describe("getUser", () => {
  it("exposes only the verified identity fields; an absent MFA claim reads as false", async () => {
    const token = await provider.verifyToken(
      await issuer.accessToken(SUB, { nowSeconds, claims: { mfa_enabled: undefined } }),
    );
    expect(provider.getUser(token)).toEqual({
      subject: SUB,
      email: `${SUB}@example.test`,
      emailVerified: true,
      mfaEnabled: false,
    });
  });
});

describe("requireStepUp (mfa_verified_at, at most 10 minutes old; ADR-018)", () => {
  // The verifier checks exp against the real clock; the provider's step-up check uses the injected one.
  const verify = (claims: Record<string, unknown>, mfaAgeSeconds = 60) =>
    issuer
      .accessToken(SUB, {
        nowSeconds: Math.floor(Date.now() / 1000),
        claims: { mfa_verified_at: nowSeconds - mfaAgeSeconds, ...claims },
      })
      .then((token) => provider.verifyToken(token));

  async function mfaRequired(
    token: Promise<Parameters<AuthProvider["requireStepUp"]>[0]>,
    options?: Parameters<AuthProvider["requireStepUp"]>[1],
  ): Promise<void> {
    const verified = await token;
    let caught: unknown;
    try {
      provider.requireStepUp(verified, options);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(403);
    expect((caught as AppError).code).toBe("mfa_required");
  }

  it("passes with a second-factor confirmation under 10 minutes old", async () => {
    provider.requireStepUp(await verify({}, 599));
  });

  it("passes at exactly 10 minutes and fails one second later", async () => {
    provider.requireStepUp(await verify({}, 600));
    await mfaRequired(verify({}, 601));
  });

  it("fails closed when mfa_verified_at is missing, even with mfa_enabled and a fresh auth_time", async () => {
    await mfaRequired(
      verify({ mfa_verified_at: undefined, mfa_enabled: true, auth_time: Math.floor(Date.now() / 1000) }),
    );
  });

  it("fails when mfa_verified_at is a string", async () => {
    await mfaRequired(verify({ mfa_verified_at: String(nowSeconds) }));
  });

  it("fails when mfa_verified_at is not a positive integer", async () => {
    await mfaRequired(verify({ mfa_verified_at: 1.5 }));
    await mfaRequired(verify({ mfa_verified_at: -5 }));
    await mfaRequired(verify({ mfa_verified_at: true }));
  });

  it("mfa_enabled and auth_time alone never pass", async () => {
    await mfaRequired(verify({ mfa_verified_at: undefined, mfa_enabled: true, auth_time: nowSeconds }));
  });

  it("fails when mfa_verified_at is in the future beyond the skew", async () => {
    await mfaRequired(verify({}, -3600));
  });

  it("honors a custom max age", async () => {
    await mfaRequired(verify({}, 120), { maxAgeSeconds: 60 });
  });
});
