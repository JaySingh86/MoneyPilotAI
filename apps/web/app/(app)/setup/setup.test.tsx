// Household setup (WP-23), canvas "Mobile · Household setup": step 3 of 4, the method choices, the
// invite line and the bottom-bar CTA for each method.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { csvPoll } from "../../../lib/api/imports-hooks";
import { renderApp } from "../../../test/render";
import { router } from "../../../test/setup";
import { resetWp23, wp23 } from "../../../mocks/wp23-data";
import { SetupScreen } from "./SetupScreen";

beforeEach(() => {
  resetWp23("?setup=invited");
  router.push.mockClear();
  csvPoll.intervalMs = 0;
});

async function loaded() {
  await screen.findByText("Add what comes in and goes out");
  await screen.findByText(/invited · waiting to join/);
}

describe("Household setup", () => {
  it("shows step 3 of 4, the completed steps and the method choices", async () => {
    renderApp(<SetupScreen />);
    await loaded();
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip for now" }).getAttribute("href")).toBe("/overview");
    expect(
      screen.getByText("MoneyPilot builds your first month from this. No bank login needed."),
    ).toBeTruthy();
    expect(screen.getByText("Rivera household")).toBeTruthy();
    expect(screen.getByText("Jordan invited · waiting to join")).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "How to add bills and income" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    expect(within(group).getByText("Recommended")).toBeTruthy();
    expect(within(group).getByText("Coming later. Tell us if you’d use it.")).toBeTruthy();
    // The email panel: both providers, the forwarding address and the three privacy bullets.
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toBeTruthy();
    expect(await screen.findByText("rivera-7k2@in.moneypilot.app")).toBeTruthy();
    expect(screen.getByText("Your partner sees the bills we find, never your inbox")).toBeTruthy();
    // The fixture already has Sam's Gmail connected, so the bar continues; with none it connects.
    await screen.findByRole("button", { name: "Continue to your overview" });
  });

  it("resends the invite until the daily limit, then says so", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole("button", { name: "Resend" }));
      await waitFor(() => expect(wp23.invitesToday).toBe(2 + i));
      await screen.findByText(/invited · waiting to join/);
    }
    await user.click(screen.getByRole("button", { name: "Resend" }));
    await screen.findByText("You can send 5 invites a day. Try again tomorrow.");
  });

  it("connects Google: start, then the browser goes to the returned URL", async () => {
    const user = userEvent.setup();
    wp23.connections = [];
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
      search: "",
    } as Location);
    renderApp(<SetupScreen />);
    await loaded();
    // The bar does not assume Gmail: it takes you to the provider choice, and the choice connects.
    await user.click(screen.getByRole("button", { name: "Connect and scan my inbox" }));
    expect(assign).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(screen.getByRole("button", { name: "Continue with Microsoft" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/setup\?connected=outlook$/)),
    );
    vi.restoreAllMocks();
  });

  it("does not treat a broken inbox as connected", async () => {
    wp23.connections = wp23.connections.map((c) => ({ ...c, status: "error" as const }));
    renderApp(<SetupScreen />);
    await loaded();
    await screen.findByRole("button", { name: "Connect and scan my inbox" });
    expect(screen.queryByRole("button", { name: "Continue to your overview" })).toBeNull();
  });

  it("imports a CSV and builds the month from the checked items", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    await user.click(screen.getByRole("radio", { name: /Import a bank CSV/ }));
    const confirm = screen.getByRole("button", {
      name: "Confirm 0 items and build my month",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.upload(
      screen.getByLabelText("Bank CSV file"),
      new File(["a,b\n"], "checking-oct.csv", { type: "text/csv" }),
    );
    // The detections are review items with source = csv, shown here filtered in the client (Q-174).
    await screen.findByText("Found in checking-oct.csv");
    expect(screen.getByText("Monthly · next Nov 6")).toBeTruthy();
    expect(screen.getByText("+$3,150.00")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review 9 more" }));
    await user.click(screen.getByRole("checkbox", { name: /Car insurance/ }));
    const button = await screen.findByRole("button", { name: "Confirm 12 items and build my month" });
    await user.click(button);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/overview"));
    // The one left unchecked stays in the review queue.
    expect(wp23.queue.filter((i) => i.source === "csv").map((i) => i.fields.providerName)).toEqual([
      "Car insurance",
    ]);
  });

  it("says item for one and explains the disabled bar for none", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    await user.click(screen.getByRole("radio", { name: /Import a bank CSV/ }));
    expect(screen.getByText("Choose a file, then check the items to keep.")).toBeTruthy();
    await user.upload(
      screen.getByLabelText("Bank CSV file"),
      new File(["a,b\n"], "checking-oct.csv", { type: "text/csv" }),
    );
    await screen.findByText("Found in checking-oct.csv");
    await user.click(screen.getByRole("button", { name: "Review 9 more" }));
    const boxes = screen.getAllByRole("checkbox");
    for (const box of boxes.slice(1)) await user.click(box);
    expect(await screen.findByRole("button", { name: "Confirm 1 item and build my month" })).toBeTruthy();
    await user.click(boxes[0] as HTMLElement);
    expect(screen.getByText("Choose a file, then check the items to keep.")).toBeTruthy();
  });

  it("asks which column is which before reading a file with unknown headers", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    await user.click(screen.getByRole("radio", { name: /Import a bank CSV/ }));
    await user.upload(
      screen.getByLabelText("Bank CSV file"),
      new File(["Posted,Memo,Money\n"], "needs-mapping.csv", { type: "text/csv" }),
    );
    await screen.findByText("Which column is which?");
    await user.selectOptions(screen.getByLabelText("Amount"), "Money");
    await user.click(screen.getByRole("button", { name: "Use these columns" }));
    await screen.findByText("Found in needs-mapping.csv");
  });

  it("adds a bill by hand and checks the fields first", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    await user.click(screen.getByRole("radio", { name: /Enter manually/ }));
    await user.click(screen.getByRole("button", { name: "Add and enter another" }));
    expect(screen.getByText("Give it a name, like Rent.")).toBeTruthy();
    expect(screen.getByText("Enter dollars, like $2,150.00.")).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "Rent");
    await user.type(screen.getByLabelText("Amount"), "$2,150.00");
    await user.type(screen.getByLabelText("Next due"), "2026-11-01");
    await user.click(screen.getByRole("button", { name: "Add and enter another" }));
    await screen.findByText("1 bill added.");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Continue to your overview" })).toBeTruthy();
  });

  it("does not drop a typed bill on Continue: a complete one is added, a half-typed one is flagged", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    await user.click(screen.getByRole("radio", { name: /Enter manually/ }));
    await user.type(screen.getByLabelText("Name"), "Rent");
    await user.click(screen.getByRole("button", { name: "Continue to your overview" }));
    expect(await screen.findByText("Enter dollars, like $2,150.00.")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Amount"), "$2,150.00");
    await user.type(screen.getByLabelText("Next due"), "2026-11-01");
    await user.click(screen.getByRole("button", { name: "Continue to your overview" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/overview"));
    expect(screen.getByText("1 bill added.")).toBeTruthy();
  });

  it("goes straight on with nothing typed", async () => {
    const user = userEvent.setup();
    renderApp(<SetupScreen />);
    await loaded();
    await user.click(screen.getByRole("radio", { name: /Enter manually/ }));
    await user.click(screen.getByRole("button", { name: "Continue to your overview" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/overview"));
  });

  it("does not offer the bank connection", async () => {
    renderApp(<SetupScreen />);
    await loaded();
    const bank = screen.getByRole("radio", { name: /Connect a bank/ }) as HTMLButtonElement;
    expect(bank.disabled || bank.getAttribute("aria-disabled") === "true").toBe(true);
  });
});
