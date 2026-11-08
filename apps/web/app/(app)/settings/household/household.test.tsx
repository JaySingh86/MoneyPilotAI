// Members & privacy (WP-23): the canvas content, owner-only connection controls, switches, and the
// destructive actions with their confirm dialogs.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { API_BASE_URL } from "../../../../lib/config";
import { HttpResponse, http } from "msw";
import { server } from "../../../../test/server";
import { renderApp } from "../../../../test/render";
import { router } from "../../../../test/setup";
import { resetWp23, wp23 } from "../../../../mocks/wp23-data";
import { HouseholdScreen } from "./HouseholdScreen";

async function loaded() {
  await screen.findByText("Our promises");
  await screen.findByText("Email scan: 214 matched, 23 used");
}

beforeEach(() => {
  resetWp23();
  router.replace.mockClear();
});

describe("Members & privacy", () => {
  it("shows the household, members, connected data and activity from the canvas", async () => {
    renderApp(<HouseholdScreen />);
    await loaded();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Members & privacy");
    expect((screen.getByLabelText("Household name") as HTMLInputElement).value).toBe("Rivera household");
    expect((screen.getByLabelText("Cushion") as HTMLInputElement).value).toBe("$500");
    const income = screen.getByLabelText("Primary income (sets your payday)") as HTMLSelectElement;
    await waitFor(() => expect(income.value).not.toBe(""));
    expect(within(income).getByRole("option", { name: "Sam’s pay · every other Friday" })).toBeTruthy();
    expect(within(income).getByRole("option", { name: "Jordan’s pay · last Friday" })).toBeTruthy();
    expect(screen.getByText("Family Plus")).toBeTruthy();
    // WP-25's billing state carries no price, so the row shows the plan and its interval only.
    expect(screen.getByText(/billed monthly/)).toBeTruthy();
    expect(screen.queryByText(/\$7\.99/)).toBeNull();
    expect(screen.getByText("Renews Nov 26. Covers both of you.")).toBeTruthy();

    expect(screen.getByText("Created the household · Gmail connected · 2-step verification on")).toBeTruthy();
    expect(screen.getByText("Joined Oct 26 · email not connected")).toBeTruthy();
    expect(screen.getByText("Full access")).toBeTruthy();
    expect(screen.getByText("2-step verification off")).toBeTruthy();

    expect(screen.getByText("Gmail · sam•••@gmail.com")).toBeTruthy();
    expect(screen.getByText("Only Jordan can connect it, from Jordan’s own login")).toBeTruthy();
    expect(screen.getByText("rivera-7k2@in.moneypilot.app · 1 email received")).toBeTruthy();
    expect(screen.getByText("Not available yet. Nothing is connected.")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "What Jordan can see from your data" })).toBeTruthy();
    const switches = screen.getAllByRole("switch");
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    expect(screen.getByText(/Jordan never sees your inbox/)).toBeTruthy();

    expect(screen.getByText("Jordan joined the household")).toBeTruthy();
    expect(screen.getByText("MoneyPilot · Oct 27, 8:58 AM")).toBeTruthy();
    expect(screen.getByText("Sam · Oct 26, 9:05 PM")).toBeTruthy();
  });

  it("turns a switch on and keeps it", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    const address = screen.getByRole("switch", { name: "My connected email address" });
    await user.click(address);
    await waitFor(() => expect(wp23.sharing.connectedAddress).toBe(true));
    expect(address.getAttribute("aria-checked")).toBe("true");
  });

  it("lets you turn on your own 2-step verification, and reads it from the summary", async () => {
    const user = userEvent.setup();
    resetWp23("?mfa=off");
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(await screen.findByRole("button", { name: "Turn on 2-step verification" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on 2-step verification" });
    expect(await within(dialog).findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("6-digit code"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Turn on 2-step verification" })).toBeNull(),
    );
    expect(wp23.mfa.sam).toBe(true);
  });

  it("offers no 2-step action on someone else's row, only a reminder", async () => {
    renderApp(<HouseholdScreen />);
    await loaded();
    expect(screen.queryByRole("button", { name: "Turn on 2-step verification" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remind Jordan" })).toBeTruthy();
  });

  it("resends a pending invite through the resend endpoint and shows the invitee's name", async () => {
    const user = userEvent.setup();
    resetWp23("?setup=invited");
    renderApp(<HouseholdScreen />);
    await screen.findByText("Jordan invited");
    await user.click(screen.getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(wp23.invitesToday).toBe(2));
    expect(wp23.invite?.id).toBe("6d8e0009-0000-4000-8000-000000000001");
  });

  it("reminds Jordan about 2-step verification once", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Remind Jordan" }));
    await screen.findByText("Reminder sent");
    expect(screen.queryByRole("button", { name: "Remind Jordan" })).toBeNull();
  });

  it("saves the household name and cushion, then recalculates", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const cushion = screen.getByLabelText("Cushion");
    await user.clear(cushion);
    await user.type(cushion, "$750");
    await user.click(save);
    await screen.findByText("Saved. Your plan is recalculated.");
    expect(wp23.household.cushionCents).toBe(75000);
  });

  it("checks the cushion before sending it", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    const cushion = screen.getByLabelText("Cushion");
    await user.clear(cushion);
    await user.type(cushion, "lots");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter dollars, like $500.")).toBeTruthy();
    expect(wp23.household.cushionCents).toBe(50000);
  });

  it("disconnects only after a confirm, and only for the mailbox owner", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(wp23.connections).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(wp23.connections).toHaveLength(0));
  });

  it("shows a broken inbox as needing a reconnect, not as connected", async () => {
    wp23.connections = wp23.connections.map((c) => ({ ...c, status: "error" as const }));
    renderApp(<HouseholdScreen />);
    await loaded();
    expect(screen.getByText("Needs reconnecting")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/imports");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});

describe("loading, error and empty states (§5.3)", () => {
  const H = `${API_BASE_URL}/v1/households/5f0c2b9e-3c1d-4a77-9a3e-0000000000a1`;
  const fail = (path: string) =>
    server.use(http.get(`${H}${path}`, () => new HttpResponse(null, { status: 500 })));

  it("sharing, forwarding, income and activity failures each say so and can be retried", async () => {
    fail("/sharing");
    fail("/forwarding-address");
    fail("/items");
    renderApp(<HouseholdScreen />);
    expect(await screen.findByText("We couldn’t load these settings.")).toBeTruthy();
    expect(await screen.findByText("We couldn’t load the address. Try again.")).toBeTruthy();
    expect(await screen.findByText("We couldn’t load your income items.")).toBeTruthy();
    // No misleading "Add an income first" when the real problem is a failed load.
    expect(screen.queryByRole("option", { name: "Add an income first" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Retry|Try again/ }).length).toBeGreaterThan(0);
  });

  it("an empty activity log says so instead of showing a blank card", async () => {
    server.use(http.get(`${H}/activity`, () => HttpResponse.json({ data: [], nextCursor: null })));
    renderApp(<HouseholdScreen />);
    expect(await screen.findByText("Nothing yet. Changes to your household show up here.")).toBeTruthy();
  });

  it("shows the canvas footer only in mock mode, which the tests run in", async () => {
    renderApp(<HouseholdScreen />);
    await loaded();
    expect(screen.getByText(/^Sample data · Viewing as/)).toBeTruthy();
  });
});

describe("Idempotency-Key", () => {
  it("the mock refuses the routes that require a key when it is missing", async () => {
    for (const path of [
      "/households",
      "/households/5f0c2b9e-3c1d-4a77-9a3e-0000000000a1/invites",
      "/households/5f0c2b9e-3c1d-4a77-9a3e-0000000000a1/items",
      "/households/5f0c2b9e-3c1d-4a77-9a3e-0000000000a1/sender-rules",
    ]) {
      const res = await fetch(`${API_BASE_URL}/v1${path}`, { method: "POST", body: "{}" });
      expect(res.status, path).toBe(400);
    }
  });
});

describe("Your data", () => {
  it("labels the destructive buttons with an ellipsis", async () => {
    renderApp(<HouseholdScreen />);
    await loaded();
    expect(screen.getByRole("button", { name: "Leave…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete household…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export data" })).toBeTruthy();
  });

  it("leaves with one confirm and goes to setup", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Leave household" }));
    await waitFor(() => expect(wp23.left).toBe(true));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/setup"));
  });

  it("asks for a 2-step code on a 403 mfa_required, then retries the leave once", async () => {
    const user = userEvent.setup();
    wp23.requireStepUp = true;
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    const leave = await screen.findByRole("dialog", { name: "Leave the household?" });
    await user.click(within(leave).getByRole("button", { name: "Leave household" }));
    const step = await screen.findByRole("dialog", { name: "Confirm it’s you" });
    expect(wp23.left).toBe(false);
    await user.type(within(step).getByLabelText("6-digit code"), "000000");
    await user.click(within(step).getByRole("button", { name: "Confirm" }));
    expect((await within(step).findByRole("alert")).textContent).toContain("That code isn’t right");
    await user.clear(within(step).getByLabelText("6-digit code"));
    await user.type(within(step).getByLabelText("6-digit code"), "123456");
    await user.click(within(step).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(wp23.left).toBe(true));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/setup"));
  });

  it("cancelling the code leaves things as they were and says why", async () => {
    const user = userEvent.setup();
    wp23.requireStepUp = true;
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    const leave = await screen.findByRole("dialog", { name: "Leave the household?" });
    await user.click(within(leave).getByRole("button", { name: "Leave household" }));
    const step = await screen.findByRole("dialog", { name: "Confirm it’s you" });
    await user.click(within(step).getByRole("button", { name: "Cancel" }));
    const alert = await within(leave).findByRole("alert");
    expect(alert.textContent).toContain("2-step verification");
    expect(wp23.left).toBe(false);
  });

  it("deletes only after the household name is typed", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Delete household…" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete household" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("Type “Rivera household” to confirm"), "Rivera");
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("Type “Rivera household” to confirm"), " household");
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await screen.findByText(/Deletion is scheduled for Nov 3\./);
    expect(wp23.deletionScheduledFor).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(wp23.deletionScheduledFor).toBeNull());
  });

  it("downloads the full log through the same step-up", async () => {
    const user = userEvent.setup();
    wp23.requireStepUp = true;
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Download full log" }));
    const step = await screen.findByRole("dialog", { name: "Confirm it’s you" });
    await user.type(within(step).getByLabelText("6-digit code"), "123456");
    await user.click(within(step).getByRole("button", { name: "Confirm" }));
    await screen.findByText(/The full log is in your export/);
    expect(wp23.exportRequested).toBe(true);
  });

  it("starts an export", async () => {
    const user = userEvent.setup();
    renderApp(<HouseholdScreen />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Export data" }));
    await screen.findByText(/Export started/);
    expect(wp23.exportRequested).toBe(true);
  });
});
