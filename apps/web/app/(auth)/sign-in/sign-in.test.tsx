import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../../test/render";
import { state } from "../../../mocks/state";
import { SignInFlow } from "./SignInFlow";

async function fillSignIn(password: string) {
  await userEvent.type(screen.getByLabelText("Email"), "sam@rivera-household.example");
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in screens", () => {
  it("signs in, then syncs the user with POST /me/bootstrap", async () => {
    renderApp(<SignInFlow />, { signedIn: false });
    await fillSignIn("correct horse");
    await screen.findByRole("heading", { name: "Sign in" }); // still mounted until the router redirects
    await expect.poll(() => state.bootstrapCalls).toBe(1);
  });

  it("shows a calm error for the wrong password and keeps what was typed", async () => {
    renderApp(<SignInFlow />, { signedIn: false });
    await fillSignIn("wrong");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That email and password don’t match");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("sam@rivera-household.example");
    expect(state.bootstrapCalls).toBe(0);
  });

  it("asks for the authenticator code when the account has MFA", async () => {
    renderApp(<SignInFlow />, { signedIn: false });
    await fillSignIn("mfa");
    await screen.findByRole("heading", { name: "Check your authenticator app" });
    await userEvent.type(screen.getByLabelText("Authenticator code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That code isn’t right");
    await userEvent.clear(screen.getByLabelText("Authenticator code"));
    await userEvent.type(screen.getByLabelText("Authenticator code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await expect.poll(() => state.bootstrapCalls).toBe(1);
  });

  it("walks through password reset and back to sign-in", async () => {
    renderApp(<SignInFlow />, { signedIn: false });
    await userEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    await userEvent.type(screen.getByLabelText("Email"), "sam@rivera-household.example");
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Choose a new password" });
    await userEvent.type(screen.getByLabelText("Emailed code"), "123456");
    await userEvent.type(screen.getByLabelText("New password"), "A-new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.getByRole("status").textContent).toContain("Your password is changed");
  });

  it("creates an account and confirms the email", async () => {
    renderApp(<SignInFlow />, { signedIn: false });
    await userEvent.click(screen.getByRole("button", { name: "Create an account" }));
    await userEvent.type(screen.getByLabelText("First name"), "Sam");
    await userEvent.type(screen.getByLabelText("Email"), "sam@rivera-household.example");
    await userEvent.type(screen.getByLabelText("Password"), "A-new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Confirm your email" });
    await userEvent.type(screen.getByLabelText("Emailed code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    await screen.findByRole("heading", { name: "Sign in" });
  });

  it("says the environment has no sign-in when Cognito isn't configured", async () => {
    const { createAmplifyAdapter } = await import("../../../lib/auth/amplify-adapter");
    renderApp(<SignInFlow />, { adapter: createAmplifyAdapter(null) });
    await screen.findByRole("heading", { name: "Sign in" });
    await userEvent.type(screen.getByLabelText("Email"), "a@b.example");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Sign-in isn’t set up");
  });
});
