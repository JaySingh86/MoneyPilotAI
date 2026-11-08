import { describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../../auth/testing/fake-supabase";
import { AuthService } from "./service";

describe("AuthService.confirmPasswordReset", () => {
  it("still succeeds when revoking the other sessions fails, and reports a metric without the address", async () => {
    const fake = await FakeSupabase.create();
    const metrics = { providerRateLimited: vi.fn(), logoutOthersFailed: vi.fn() };
    const service = new AuthService(fake.gotrue(), metrics);
    const email = "reset@example.test";
    await service.signUp({ firstName: "R", email, password: "a long password" });
    await service.confirmEmail({ email, code: fake.lastMail(email, "signup")?.code });
    await service.requestPasswordReset(email);

    fake.failPath = "/logout";
    const session = await service.confirmPasswordReset({
      email,
      code: fake.lastMail(email, "recovery")?.code,
      newPassword: "a brand new passphrase",
    });
    expect(session.accessToken).toBeTruthy();
    expect(metrics.logoutOthersFailed).toHaveBeenCalledTimes(1);
    expect(metrics.logoutOthersFailed.mock.calls[0]).toEqual([]); // no argument: nothing to leak
  });
});
