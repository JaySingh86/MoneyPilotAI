// SupabaseAuthProvider against a fake JWKS issuer: no network, no Supabase credential.
import { SignJWT, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createSupabaseProvider, totpProofAt } from "./supabase";
import type { AuthProvider } from "./provider";
import { FakeSupabase } from "./testing/fake-supabase";

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

let fake: FakeSupabase;
let provider: AuthProvider;
beforeAll(async () => {
  fake = await FakeSupabase.create();
  provider = createSupabaseProvider(fake.providerConfig(), { now: () => NOW_MS });
});

const token = (subject: string, options: Parameters<FakeSupabase["accessToken"]>[1] = {}) =>
  fake.accessToken(subject, { nowSeconds: NOW_S, ...options });

describe("verifyToken", () => {
  it("accepts a good token and maps sub and email", async () => {
    const verified = await provider.verifyToken(await token("u1", { email: "a@example.test" }));
    expect(verified).toMatchObject({ subject: "u1", email: "a@example.test", expiresAt: NOW_S + 3600 });
  });

  it("refuses the wrong issuer, audience, role, anonymous users and a forged signature", async () => {
    const other = await FakeSupabase.create();
    for (const bad of [
      await token("u", { claims: { iss: "https://evil.supabase.co/auth/v1" } }),
      await token("u", { claims: { aud: "something-else" } }),
      await token("u", { claims: { aud: undefined } }),
      await token("u", { claims: { role: "service_role" } }),
      await token("u", { claims: { role: undefined } }),
      await token("u", { claims: { is_anonymous: true } }),
      await other.accessToken("u", { nowSeconds: NOW_S }),
      await token("u", { kid: "unknown-kid" }),
      "not-a-jwt",
      "",
      "a".repeat(9000),
    ]) {
      await expect(provider.verifyToken(bad)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    }
  });

  it("refuses an unsigned token and an HS256 token", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none" })}.${b64({ sub: "u", aud: "authenticated", role: "authenticated", iss: fake.issuer, exp: NOW_S + 60 })}.`;
    await expect(provider.verifyToken(none)).rejects.toMatchObject({ status: 401 });
    const hs = await new SignJWT({ sub: "u", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: fake.kid })
      .setIssuer(fake.issuer)
      .setAudience("authenticated")
      .setExpirationTime(NOW_S + 60)
      .sign(new TextEncoder().encode("legacy-shared-secret-legacy-shared-secret"));
    await expect(provider.verifyToken(hs)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses an RS256 token signed by a key the JWKS does not have", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const rs = await new SignJWT({ sub: "u", role: "authenticated" })
      .setProtectedHeader({ alg: "RS256", kid: fake.kid })
      .setIssuer(fake.issuer)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(provider.verifyToken(rs)).rejects.toMatchObject({ status: 401 });
  });

  it("expiry: an expired token says so; 60 s of skew is tolerated, 5 minutes is not", async () => {
    const real = createSupabaseProvider(fake.providerConfig());
    const nowS = Math.floor(Date.now() / 1000);
    const expired = await fake.accessToken("u", { nowSeconds: nowS - 4000 });
    await expect(real.verifyToken(expired)).rejects.toMatchObject({
      status: 401,
      detail: "The access token has expired.",
    });
    const justExpired = await fake.accessToken("u", { nowSeconds: nowS - 3600 - 30 });
    await expect(real.verifyToken(justExpired)).resolves.toMatchObject({ subject: "u" });
    const longExpired = await fake.accessToken("u", { nowSeconds: nowS - 3600 - 300 });
    await expect(real.verifyToken(longExpired)).rejects.toMatchObject({ status: 401 });
  });

  it("a malformed email claim becomes null rather than failing the token", async () => {
    const verified = await provider.verifyToken(await token("u", { claims: { email: 5 } }));
    expect(verified.email).toBeNull();
  });
});

describe("getUser", () => {
  it("reads the confirmed email and verified TOTP factor from the user record, not the token", async () => {
    const v = await provider.verifyToken(await token("u-ok", { email: "ok@example.test" }));
    await expect(provider.getUser(v)).resolves.toEqual({
      subject: "u-ok",
      email: "ok@example.test",
      emailVerified: true,
      mfaEnabled: true,
      firstName: null,
    });
  });

  it("user_metadata.email_verified in the token is ignored", async () => {
    const v = await provider.verifyToken(
      await token("u-meta", { emailConfirmed: false, claims: { user_metadata: { email_verified: true } } }),
    );
    expect((await provider.getUser(v)).emailVerified).toBe(false);
  });

  it("no verified factor: mfaEnabled is false", async () => {
    const v = await provider.verifyToken(await token("u-nomfa", { totp: false }));
    expect((await provider.getUser(v)).mfaEnabled).toBe(false);
  });

  it("an unreachable provider is a 503, not a verified identity", async () => {
    const v = await provider.verifyToken(await token("u-down"));
    fake.failNext = true;
    await expect(provider.getUser(v)).rejects.toMatchObject({ status: 503 });
  });
});

describe("requireStepUp", () => {
  const stepUp = async (
    options: Parameters<FakeSupabase["accessToken"]>[1],
    stepUpOptions?: { maxAgeSeconds: number },
  ) => provider.requireStepUp(await provider.verifyToken(await token("s", options)), stepUpOptions);
  const mfaRequired = expect.objectContaining({ code: "mfa_required", status: 403 });

  it("passes with aal2 and a fresh totp proof", async () => {
    await expect(stepUp({ totpAt: NOW_S - 60 })).resolves.toBeUndefined();
  });

  it("passes at exactly 10 minutes and fails at 10 minutes and a second", async () => {
    await expect(stepUp({ totpAt: NOW_S - 600 })).resolves.toBeUndefined();
    await expect(stepUp({ totpAt: NOW_S - 601 })).rejects.toEqual(mfaRequired);
  });

  it("honours a shorter maxAgeSeconds", async () => {
    await expect(stepUp({ totpAt: NOW_S - 120 }, { maxAgeSeconds: 60 })).rejects.toEqual(mfaRequired);
  });

  it("fails closed: a password-only (aal1) session, even with a factor enrolled", async () => {
    await expect(stepUp({ totp: true, totpAt: null })).rejects.toEqual(mfaRequired);
  });

  it("fails closed: aal2 without a totp amr entry, a non-totp entry, or a malformed timestamp", async () => {
    for (const claims of [
      { aal: "aal2", amr: [{ method: "password", timestamp: NOW_S }] },
      { aal: "aal2", amr: [{ method: "oauth", timestamp: NOW_S }] },
      { aal: "aal2", amr: [{ method: "totp", timestamp: String(NOW_S) }] },
      { aal: "aal2", amr: [{ method: "totp", timestamp: -5 }] },
      { aal: "aal2", amr: [{ method: "totp", timestamp: NOW_S + 0.5 }] },
      { aal: "aal2", amr: [{ method: "totp" }] },
      { aal: "aal2", amr: "totp" },
      { aal: "aal2", amr: undefined },
      { aal: "aal1", amr: [{ method: "totp", timestamp: NOW_S }] },
      { aal: undefined, amr: [{ method: "totp", timestamp: NOW_S }] },
      { aal: "AAL2", amr: [{ method: "totp", timestamp: NOW_S }] },
    ]) {
      await expect(stepUp({ claims }), JSON.stringify(claims)).rejects.toEqual(mfaRequired);
    }
  });

  it("takes the newest totp entry when there are several", async () => {
    const v = await provider.verifyToken(
      await token("s", {
        claims: {
          aal: "aal2",
          amr: [
            { method: "totp", timestamp: NOW_S - 5000 },
            { method: "password", timestamp: NOW_S },
            { method: "totp", timestamp: NOW_S - 10 },
          ],
        },
      }),
    );
    expect(v.mfaVerifiedAt).toBe(NOW_S - 10);
    expect(() => provider.requireStepUp(v)).not.toThrow();
  });

  it("a proof from the future (beyond skew) fails", async () => {
    await expect(stepUp({ totpAt: NOW_S + 3600 })).rejects.toEqual(mfaRequired);
  });
});

describe("totpProofAt", () => {
  it("is null without aal2", () => {
    expect(totpProofAt("aal1", [{ method: "totp", timestamp: 5 }])).toBeNull();
    expect(totpProofAt("aal2", undefined)).toBeNull();
  });
});
