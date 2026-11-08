import { describe, expect, it, vi } from "vitest";
import { AuthConfigError, loadCognitoConfig } from "./config";
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
  COGNITO_REGION: "us-east-1",
  COGNITO_USER_POOL_ID: "us-east-1_AbC123xyz",
  COGNITO_CLIENT_ID: "client",
};

describe("loadCognitoConfig", () => {
  it("returns the settings when they agree", () => {
    expect(loadCognitoConfig({ NODE_ENV: "production", ...good })).toEqual({
      region: "us-east-1",
      userPoolId: "us-east-1_AbC123xyz",
      clientId: "client",
    });
  });

  it("production with any setting missing is a startup error", () => {
    for (const key of Object.keys(good)) {
      expect(() => loadCognitoConfig({ NODE_ENV: "production", ...good, [key]: "" })).toThrow(
        AuthConfigError,
      );
    }
    expect(() => loadCognitoConfig({ NODE_ENV: "production" })).toThrow(AuthConfigError);
  });

  it("outside production, missing settings mean sign-in is not configured", () => {
    expect(loadCognitoConfig({})).toBeNull();
    expect(loadCognitoConfig({ NODE_ENV: "development", COGNITO_REGION: "us-east-1" })).toBeNull();
  });

  it("a region that disagrees with the pool id, or a malformed pool id, is an error everywhere", () => {
    expect(() => loadCognitoConfig({ ...good, COGNITO_REGION: "eu-west-1" })).toThrow(/region/i);
    expect(() => loadCognitoConfig({ ...good, COGNITO_USER_POOL_ID: "nonsense" })).toThrow(AuthConfigError);
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
