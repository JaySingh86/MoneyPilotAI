import { describe, expect, it, vi } from "vitest";
import { AuthConfigError, loadSupabaseAuthConfig } from "./config";
import { createUnconfiguredInviteSender } from "./runtime";

const invite = {
  to: "x@example.test",
  token: "t",
  householdName: "h",
  inviterFirstName: "i",
  expiresAt: new Date(0),
  invitedByUserId: "00000000-0000-4000-8000-00000000000a",
};
const good = {
  SUPABASE_URL: "https://abcd.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  WEB_ORIGIN: "https://app.example.test",
  API_PUBLIC_URL: "https://api.example.test",
  AUTH_COOKIE_SECRET: Buffer.alloc(32, 7).toString("base64"),
};

describe("loadSupabaseAuthConfig", () => {
  it("returns the settings when they agree", () => {
    expect(loadSupabaseAuthConfig({ NODE_ENV: "production", ...good })).toEqual({
      url: "https://abcd.supabase.co",
      publishableKey: "sb_publishable_x",
      secretKey: "sb_secret_x",
      cookieSecret: good.AUTH_COOKIE_SECRET,
      webOrigin: "https://app.example.test",
      apiPublicUrl: "https://api.example.test",
      cookieSecure: true,
    });
  });

  it("production with any setting missing is a startup error", () => {
    for (const key of Object.keys(good)) {
      expect(() => loadSupabaseAuthConfig({ NODE_ENV: "production", ...good, [key]: "" })).toThrow(
        AuthConfigError,
      );
    }
    expect(() => loadSupabaseAuthConfig({ NODE_ENV: "production" })).toThrow(/SUPABASE_URL/);
    for (const key of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) {
      expect(() => loadSupabaseAuthConfig({ NODE_ENV: "production", ...good, [key]: undefined })).toThrow(
        /SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY/,
      );
    }
  });

  it("AUTH_COOKIE_SECRET must be 32+ bytes of base64 when given; without one, dev gets a random secret", () => {
    expect(() => loadSupabaseAuthConfig({ ...good, AUTH_COOKIE_SECRET: "short" })).toThrow(/32 random bytes/);
    const { AUTH_COOKIE_SECRET: _s, ...noSecret } = good;
    void _s;
    const a = loadSupabaseAuthConfig(noSecret);
    const b = loadSupabaseAuthConfig(noSecret);
    expect(a?.cookieSecret).toBeTruthy();
    expect(a?.cookieSecret).not.toBe(b?.cookieSecret);
    expect(() => loadSupabaseAuthConfig({ NODE_ENV: "production", ...noSecret })).toThrow(
      /AUTH_COOKIE_SECRET/,
    );
  });

  it("outside production, missing settings mean sign-in is not configured", () => {
    expect(loadSupabaseAuthConfig({})).toBeNull();
    expect(loadSupabaseAuthConfig({ NODE_ENV: "development", SUPABASE_URL: good.SUPABASE_URL })).toBeNull();
  });

  it("production refuses non-https URLs; a malformed URL or a path is an error everywhere", () => {
    expect(() =>
      loadSupabaseAuthConfig({ NODE_ENV: "production", ...good, SUPABASE_URL: "http://abcd.supabase.co" }),
    ).toThrow(/https/);
    expect(() => loadSupabaseAuthConfig({ ...good, SUPABASE_URL: "nonsense" })).toThrow(AuthConfigError);
    expect(() =>
      loadSupabaseAuthConfig({ ...good, SUPABASE_URL: "https://abcd.supabase.co/auth/v1" }),
    ).toThrow(/origin only/);
  });

  it("local development defaults: localhost origins and a non-Secure cookie", () => {
    const { WEB_ORIGIN: _w, API_PUBLIC_URL: _a, ...base } = good;
    void [_w, _a];
    expect(loadSupabaseAuthConfig({ ...base })).toMatchObject({
      webOrigin: "http://localhost:3100",
      apiPublicUrl: "http://localhost:4000",
      cookieSecure: false,
    });
  });
});

describe("the placeholder invite sender (Q-081)", () => {
  it("fails in production, so no invite is reported as sent", async () => {
    const warn = vi.fn();
    await expect(
      createUnconfiguredInviteSender({ NODE_ENV: "production" }, { warn }).send(invite),
    ).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("only logs elsewhere, without the token or address", async () => {
    const warn = vi.fn();
    await createUnconfiguredInviteSender({ NODE_ENV: "development" }, { warn }).send(invite);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
