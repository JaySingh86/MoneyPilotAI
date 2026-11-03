import { describe, expect, it } from "vitest";
import {
  AcceptInviteBody,
  BootstrapBody,
  CreateHouseholdBody,
  PatchHouseholdBody,
  PatchMeBody,
} from "../index";

describe("identity and household request contracts", () => {
  it("bootstrap has no email field (the email comes from the verified token)", () => {
    expect(BootstrapBody.safeParse({ firstName: "Sam" }).success).toBe(true);
    expect(BootstrapBody.safeParse({ firstName: "Sam", email: "a@example.test" }).success).toBe(false);
    expect(PatchMeBody.safeParse({ email: "a@example.test" }).success).toBe(false);
    expect(PatchMeBody.safeParse({}).success).toBe(false);
  });

  it("time zones must be IANA names", () => {
    expect(BootstrapBody.safeParse({ timezone: "America/New_York" }).success).toBe(true);
    expect(BootstrapBody.safeParse({ timezone: "Mars/Base" }).success).toBe(false);
  });

  it("money is integer cents and plan cannot be set by the client", () => {
    expect(CreateHouseholdBody.safeParse({ name: "R", cushionCents: 50000 }).success).toBe(true);
    expect(CreateHouseholdBody.safeParse({ name: "R", cushionCents: 500.5 }).success).toBe(false);
    expect(CreateHouseholdBody.safeParse({ name: "R", plan: "family_plus" }).success).toBe(false);
    expect(PatchHouseholdBody.safeParse({ cushionCents: -1 }).success).toBe(false);
  });

  it("invite tokens are 43 base64url characters", () => {
    expect(AcceptInviteBody.safeParse({ token: "A".repeat(43) }).success).toBe(true);
    expect(AcceptInviteBody.safeParse({ token: "A".repeat(42) }).success).toBe(false);
    expect(AcceptInviteBody.safeParse({ token: "A".repeat(42) + "+" }).success).toBe(false);
  });
});
