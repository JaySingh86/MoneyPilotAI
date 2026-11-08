// Email & imports (WP-23): the canvas inbox, confirm and ignore updating the queue and nav badge, undo,
// the connect flow and the owner-only rules (DESIGN_SPEC §5.1, §6 rule 14).
import { ReviewDecision as ReviewDecisionSchema, ReviewItemPage, AppliedChangePage } from "@mp/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../../test/render";
import { csvPoll } from "../../../lib/api/imports-hooks";
import { API_BASE_URL } from "../../../lib/config";
import { resetWp23, wp23 } from "../../../mocks/wp23-data";
import { ImportsScreen } from "./ImportsScreen";
import { MAX_CSV_BYTES } from "./csv-flow";
import { parseConnectResult } from "./connect-result";

const API = `${API_BASE_URL}/v1`;
const HID = "5f0c2b9e-3c1d-4a77-9a3e-0000000000a1";

async function loaded() {
  // Titles of `update` cards come from the matched item's name, looked up once the items have loaded (Q-171).
  await screen.findByRole("heading", { name: "Electricity bill" });
}

beforeEach(() => {
  resetWp23();
  csvPoll.intervalMs = 0;
});

describe("mock responses follow the contracts", () => {
  it("parse with the WP-14 schemas", async () => {
    const queue = await (await fetch(`${API}/households/${HID}/review-items?state=queued`)).json();
    // `matchItemId` is the shared items mock's own id ("b-power"), which is not a UUID; the shape is otherwise exact.
    const withUuids = {
      ...queue,
      data: queue.data.map((i: { matchItemId: string | null }) => ({
        ...i,
        matchItemId: i.matchItemId ? "6d8e0002-0000-4000-8000-000000000001" : null,
      })),
    };
    const parsed = ReviewItemPage.safeParse(withUuids);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    const applied = await (await fetch(`${API}/households/${HID}/applied-changes`)).json();
    expect(AppliedChangePage.safeParse(applied).success).toBe(true);
    const id = queue.data[1].id as string;
    const decision = await (
      await fetch(`${API}/households/${HID}/review-items/${id}/confirm`, { method: "POST" })
    ).json();
    const uuid = "6d8e0002-0000-4000-8000-000000000001";
    decision.item.matchItemId = uuid;
    decision.appliedChange.entityId = uuid;
    expect(ReviewDecisionSchema.safeParse(decision).success).toBe(true);
    expect(decision.plan.safeToSpendCents).toBe(99764);
  });
});

describe("Email & imports", () => {
  it("shows the four items to review and the three applied changes", async () => {
    renderApp(<ImportsScreen />);
    await loaded();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Let your inbox fill in the bills");
    expect(screen.getByText("4 to review")).toBeTruthy();
    for (const title of [
      "Renters insurance renewal",
      "Electricity bill",
      "Health plan open enrollment",
      "Antivirus auto-renewal",
    ])
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByText("92%")).toBeTruthy();
    expect(screen.getByText("23 from email & CSV · 2 typed by hand")).toBeTruthy();
    // `planDelta` is null for now, so no "Safe to spend goes from … to …" sentence (Q-171).
    expect(screen.queryByText("Safe to spend goes from", { exact: false })).toBeNull();
    expect(screen.getByText("Replaces the estimate with the actual amount.")).toBeTruthy();
    const applied = await screen.findByText("Internet, $70.00 due Nov 5");
    expect(applied).toBeTruthy();
    expect(screen.getByText("Streaming bundle, $19.99 → $22.99")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Undo / })).toHaveLength(3);
  });

  it("confirming electricity says what changed and the queue drops to 3", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    const card = screen.getByRole("article", { name: "Electricity bill" });
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    const status = await screen.findByText("Electricity set to $151.37. Safe to spend is now $997.");
    expect(status.closest("[role=status]")).toBeTruthy();
    await screen.findByText("3 to review");
    expect(screen.queryByRole("heading", { name: "Electricity bill" })).toBeNull();
  });

  it("ignoring removes the item and says so", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    const card = screen.getByRole("article", { name: "Antivirus auto-renewal" });
    await user.click(within(card).getByRole("button", { name: "Ignore" }));
    await screen.findByText("Ignored. We won’t suggest this email again.");
    await screen.findByText("3 to review");
  });

  it("editing fixes the amount and applies it as edited", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    const card = screen.getByRole("article", { name: "Electricity bill" });
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const amount = within(dialog).getByLabelText("Amount");
    await user.clear(amount);
    await user.type(amount, "abc");
    await user.click(within(dialog).getByRole("button", { name: "Save and apply" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("Enter the amount as dollars");
    await user.clear(amount);
    await user.type(amount, "$160.00");
    await user.click(within(dialog).getByRole("button", { name: "Save and apply" }));
    await screen.findByText(/Electricity set to \$160\.00\./);
    await screen.findByText("3 to review");
  });

  it("shows the empty state when everything is decided", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    for (let left = 4; left > 0; left--) {
      await user.click(screen.getAllByRole("button", { name: "Ignore" })[0] as HTMLElement);
      await screen.findByText(`${left - 1} to review`);
    }
    expect(
      screen.getByText("All caught up. New bills and renewals will appear here as they arrive."),
    ).toBeTruthy();
  });

  it("undoes an applied change", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await screen.findByText("Internet, $70.00 due Nov 5");
    await user.click(screen.getByRole("button", { name: "Undo Internet, $70.00 due Nov 5" }));
    await screen.findByText("Internet is back to how it was.");
    await waitFor(() => expect(screen.queryByText("Internet, $70.00 due Nov 5")).toBeNull());
    expect(screen.getAllByRole("button", { name: /^Undo / })).toHaveLength(2);
  });

  it("explains a 403 approval_required when undoing the partner's item", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await screen.findByText("Car insurance renewal, $684.00 due Nov 4");
    await user.click(screen.getByRole("button", { name: /^Undo Car insurance renewal/ }));
    const alert = await screen.findByText("This is on Jordan’s item. Ask Jordan to approve it.");
    expect(alert.closest("[role=alert]")).toBeTruthy();
    expect(screen.getByText("Car insurance renewal, $684.00 due Nov 4")).toBeTruthy();
  });

  it("shows the empty household inbox in the new-household scenario", async () => {
    renderApp(<ImportsScreen />, { scenario: "empty" });
    await screen.findByText("All caught up. New bills and renewals will appear here as they arrive.");
    expect(screen.getByText("0 to review")).toBeTruthy();
  });
});

describe("Connected sources", () => {
  it("masks Sam's Gmail and lets only Sam pause or disconnect it", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await screen.findByText("Gmail · sam•••@gmail.com");
    expect(screen.getByText(/Read-only · checked 12 min ago/)).toBeTruthy();
    expect(
      screen.getByText(/Looked back 13 months to catch yearly renewals · 214 emails matched, 23 used/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    // Jordan's email: no connect or disconnect for Sam, only a reminder.
    expect(screen.getByText("Not connected. Only Jordan can connect it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect (Gmail|Outlook)/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remind Jordan to connect" }));
    await screen.findByRole("button", { name: "Reminder sent" });
    // Disconnect asks first.
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Not connected.");
    expect(wp23.connections).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeTruthy();
  });

  it("pauses and resumes", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await user.click(await screen.findByRole("button", { name: "Pause" }));
    await screen.findByRole("button", { name: "Resume" });
    expect(screen.getByText("Paused. We aren’t reading new emails.")).toBeTruthy();
  });

  it("shows a broken inbox as needing a reconnect, not as healthy", async () => {
    const user = userEvent.setup();
    wp23.connections = wp23.connections.map((c) => ({ ...c, status: "error" as const }));
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
      search: "",
    } as Location);
    renderApp(<ImportsScreen />);
    await screen.findByText("Needs reconnecting");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByText(/We can’t read this inbox right now/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/imports\?connected=gmail$/)),
    );
    vi.restoreAllMocks();
  });

  it("starts the connect flow and sends the browser to the returned URL", async () => {
    const user = userEvent.setup();
    wp23.connections = [];
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
      search: "",
    } as Location);
    renderApp(<ImportsScreen />);
    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/imports\?connected=gmail$/)),
    );
    vi.restoreAllMocks();
  });

  it("connecting asks for a 2-step code first when the API says mfa_required, then retries once", async () => {
    const user = userEvent.setup();
    wp23.connections = [];
    wp23.requireStepUp = true;
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
      search: "",
    } as Location);
    renderApp(<ImportsScreen />);
    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    const step = await screen.findByRole("dialog", { name: "Confirm it’s you" });
    expect(assign).not.toHaveBeenCalled();
    await user.type(within(step).getByLabelText("6-digit code"), "123456");
    await user.click(within(step).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/imports\?connected=gmail$/)),
    );
    vi.restoreAllMocks();
  });

  it("only ever sends returnTo as the /imports or /setup enum", async () => {
    const bad = await fetch(`${API}/email-connections/gmail/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnTo: "https://evil.example/" }),
    });
    expect(bad.status).toBe(400);
  });

  it("shows the forwarding address from the fixture", async () => {
    renderApp(<ImportsScreen />);
    expect(await screen.findByText("rivera-7k2@in.moneypilot.app")).toBeTruthy();
    // There is no "latest import" endpoint (Q-174): the sample household starts with the canvas's import, and an
    // upload in this session replaces it (see "CSV upload").
    expect(screen.getByText("checking-oct.csv · imported Oct 26")).toBeTruthy();
  });

  it("lists watched senders and turns one off", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await user.click(await screen.findByRole("button", { name: "Manage watched senders (23)" }));
    const dialog = await screen.findByRole("dialog");
    const toggle = await within(dialog).findByRole("switch", { name: "citypowerlight.example" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
});

describe("CSV upload", () => {
  const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "Upload new" }));
    return screen.findByRole("dialog");
  };

  it("uploads, reads the file and sends what it found to the review queue", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    const dialog = await openDialog(user);
    const file = new File(["date,desc,amount\n"], "checking-oct.csv", { type: "text/csv" });
    await user.upload(within(dialog).getByLabelText("Bank CSV file"), file);
    expect(await within(dialog).findByText(/Found 13 repeating items/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    // The detections are review items with source = csv, in the normal queue.
    expect(await screen.findByText("17 to review")).toBeTruthy();
    expect(screen.getAllByText("Bank CSV").length).toBeGreaterThan(0);
    expect(screen.getByText("checking-oct.csv · imported Oct 27")).toBeTruthy();
  });

  it("asks which column is which when the headers are not recognised, then reads the file", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    const dialog = await openDialog(user);
    await user.upload(
      within(dialog).getByLabelText("Bank CSV file"),
      new File(["Posted,Memo,Money\n"], "needs-mapping.csv", { type: "text/csv" }),
    );
    expect(await within(dialog).findByText("Which column is which?")).toBeTruthy();
    // The suggestion fills date and description; the amount column is still ours to choose.
    await user.click(within(dialog).getByRole("button", { name: "Use these columns" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Choose the amount column");
    await user.selectOptions(within(dialog).getByLabelText("Amount"), "Money");
    await user.click(within(dialog).getByRole("button", { name: "Use these columns" }));
    expect(await within(dialog).findByText(/Found 13 repeating items/)).toBeTruthy();
  });

  it("explains a file that could not be read", async () => {
    const user = userEvent.setup();
    renderApp(<ImportsScreen />);
    await loaded();
    const dialog = await openDialog(user);
    await user.upload(
      within(dialog).getByLabelText("Bank CSV file"),
      new File(["x"], "broken.csv", { type: "text/csv" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toContain("couldn’t read that file");
  });

  it("refuses a file that is not a CSV, and one over 10 MB", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderApp(<ImportsScreen />);
    await loaded();
    const dialog = await openDialog(user);
    await user.upload(within(dialog).getByLabelText("Bank CSV file"), new File(["x"], "notes.pdf"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Choose a .csv file");
    const big = new File(["x"], "big.csv", { type: "text/csv" });
    Object.defineProperty(big, "size", { value: MAX_CSV_BYTES + 1 });
    await user.upload(within(dialog).getByLabelText("Bank CSV file"), big);
    expect((await within(dialog).findByRole("alert")).textContent).toContain("over 10 MB");
  });
});

describe("connect callback", () => {
  it("handles success and failure returns", () => {
    expect(parseConnectResult("?connected=gmail")).toMatchObject({ kind: "connected", provider: "gmail" });
    expect(parseConnectResult("?connected=outlook")).toMatchObject({
      kind: "connected",
      provider: "outlook",
    });
    expect(parseConnectResult("?connect_error=access_denied")).toEqual({
      kind: "error",
      message: "Access wasn’t allowed, so nothing was connected. You can try again any time.",
    });
    expect(parseConnectResult("?connect_error=server")?.kind).toBe("error");
    expect(parseConnectResult("?connected=evil")).toBeNull();
    expect(parseConnectResult("")).toBeNull();
  });
});
