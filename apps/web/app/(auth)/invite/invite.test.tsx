// The invite page (WP-15 links to `/invite?token=…`): signed out it offers create account and sign in, signed in it
// accepts through WP-05's endpoint, and every refusal has its own calm message.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "../../../test/render";
import { router } from "../../../test/setup";
import { resetWp23, wp23 } from "../../../mocks/wp23-data";
import { InviteAccept } from "./InviteAccept";
import { inviteProblem, readInviteToken, recallInviteToken } from "./invite";
import { SignInFlow } from "../sign-in/SignInFlow";
import { ApiError } from "../../../lib/api/client";

const token = (first: string) => `${first}${"a".repeat(42)}`;

function openLink(first: string | null) {
  window.history.replaceState(null, "", first === null ? "/invite" : `/invite?token=${token(first)}`);
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetWp23();
  router.replace.mockClear();
});

describe("reading the token", () => {
  it("accepts only a 43-character base64url token", () => {
    expect(readInviteToken(`?token=${token("V")}`)).toBe(token("V"));
    expect(readInviteToken("?token=short")).toBeNull();
    expect(readInviteToken("")).toBeNull();
  });
});

describe("signed out", () => {
  it("offers Create account and Sign in without naming anyone", async () => {
    openLink("V");
    renderApp(<InviteAccept />, { signedIn: false });
    await screen.findByRole("heading", { name: "You’ve been invited to a household" });
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("signs in, then accepts and goes to the overview", async () => {
    const user = userEvent.setup();
    openLink("V");
    renderApp(<InviteAccept />, { signedIn: false });
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    await user.type(screen.getByLabelText("Email"), "sam@rivera-household.example");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getAllByRole("button", { name: "Sign in" })[0] as HTMLElement);
    await waitFor(() => expect(wp23.joinedByInvite).toBe(true));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/overview"));
  });

  it("opens on the sign-up form from Create account", async () => {
    const user = userEvent.setup();
    openLink("V");
    renderApp(<InviteAccept />, { signedIn: false });
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to the invitation" }));
    await screen.findByRole("heading", { name: "You’ve been invited to a household" });
  });

  it("explains a link with no usable token", async () => {
    openLink(null);
    renderApp(<InviteAccept />, { signedIn: false });
    await screen.findByRole("heading", { name: "This invitation link isn’t complete" });
  });
});

describe("signed in", () => {
  it("accepts and goes to the overview", async () => {
    openLink("V");
    renderApp(<InviteAccept />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/overview"));
    expect(wp23.joinedByInvite).toBe(true);
  });

  it("goes to setup when the household has no payday yet", async () => {
    wp23.household.primaryIncomeItemId = null;
    openLink("V");
    renderApp(<InviteAccept />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/setup"));
  });

  it.each([
    ["E", "This invitation has expired."],
    ["R", "This invitation was cancelled."],
    ["U", "This invitation was already used."],
    ["F", "This household is full."],
    ["H", "You’re already in a household."],
    ["M", "This invitation was sent to a different email address."],
    ["N", "We can’t find that invitation."],
  ])("refuses a %s token with friendly copy", async (first, title) => {
    openLink(first);
    renderApp(<InviteAccept />);
    expect(await screen.findAllByText(title)).not.toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    expect(wp23.joinedByInvite).toBe(false);
  });

  it("offers a way out of the wrong account", async () => {
    openLink("M");
    renderApp(<InviteAccept />);
    expect(await screen.findByRole("button", { name: "Sign out and use another address" })).toBeTruthy();
    expect(screen.getByText(/j•••@example\.test/)).toBeTruthy();
  });
});

describe("the token in the address bar", () => {
  it("is removed from the URL, kept for the tab, and cleared after a successful accept", async () => {
    openLink("V");
    renderApp(<InviteAccept />, { signedIn: false });
    await screen.findByRole("heading", { name: "You’ve been invited to a household" });
    expect(window.location.href).not.toContain(token("V"));
    expect(window.location.search).not.toContain("token");
    expect(recallInviteToken()).toBe(token("V"));
  });

  it("is cleared after a final refusal but kept when the problem may be fixed (wrong account)", async () => {
    openLink("E");
    renderApp(<InviteAccept />);
    await screen.findAllByText("This invitation has expired.");
    expect(recallInviteToken()).toBeNull();
    openLink("M");
    window.sessionStorage.clear();
    renderApp(<InviteAccept />);
    await screen.findAllByText("This invitation was sent to a different email address.");
    expect(recallInviteToken()).toBe(token("M"));
  });

  it("is cleared once accepted", async () => {
    openLink("V");
    renderApp(<InviteAccept />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/overview"));
    expect(recallInviteToken()).toBeNull();
  });

  it("brings Google sign-in (which returns to /sign-in) back to the invitation", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("mp.invite", token("V"));
    window.history.replaceState(null, "", "/sign-in");
    renderApp(<SignInFlow />, { signedIn: false });
    await user.click(await screen.findByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/invite"));
  });
});

describe("problem copy", () => {
  it("maps on the stable reason, not the detail text", () => {
    const refused = (reason: string) => new ApiError(409, "conflict", "completely different words", reason);
    expect(inviteProblem(refused("expired")).title).toBe("This invitation has expired.");
    expect(inviteProblem(refused("full")).title).toBe("This household is full.");
    expect(inviteProblem(new ApiError(409, "conflict", "This invitation has expired.")).title).toBe(
      "We couldn’t accept the invitation.",
    );
  });

  it("never says whether an account exists and falls back calmly", () => {
    expect(inviteProblem(new Error("boom")).title).toBe("We couldn’t accept the invitation.");
    expect(inviteProblem(new ApiError(500, "internal_error", "x")).message).not.toMatch(/account/i);
  });
});
