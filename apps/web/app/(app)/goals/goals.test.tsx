// Goals & planned expenses: golden values, the stepper and suggestion, and approval instead of applying (WP-18).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setFault } from "../../../mocks/state";
import { renderApp } from "../../../test/render";
import { parseDollars } from "./derive";
import { GoalsScreen } from "./GoalsScreen";

async function loaded() {
  await screen.findByRole("radiogroup", { name: "Goals" });
}
const aside = () => screen.getByRole("complementary", { name: "Selected goal" });

describe("Goals & planned expenses", () => {
  it("shows the KPI tiles and the three goal cards with their golden status", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    expect(screen.getByText("$550")).toBeTruthy();
    expect(screen.getByText("Next transfer reminder: Fri, Nov 6")).toBeTruthy();
    expect(screen.getByText("$7,970")).toBeTruthy();
    expect(screen.getByText("Across 2 goals and 1 planned expense")).toBeTruthy();
    expect(screen.getByText("$0")).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Goals" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(within(group).getByText("64%")).toBeTruthy();
    expect(within(group).getByText("Reached in Oct 2027")).toBeTruthy();
    expect(within(group).getByText("48%")).toBeTruthy();
    expect(within(group).getByText("$250 behind")).toBeTruthy();
    expect(within(group).getByText("53%")).toBeTruthy();
    expect(within(group).getByText("$380 to set aside")).toBeTruthy();
    expect(within(group).getByText("$1,150 of $2,400 · by Mar 1")).toBeTruthy();
  });

  it("lists the planned expenses ahead by date", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    const table = await screen.findByRole("table", { name: "Planned expenses by date" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(5));
    const text = table.textContent ?? "";
    expect(text.indexOf("Thanksgiving")).toBeLessThan(text.indexOf("Holiday gifts"));
    expect(text.indexOf("Holiday gifts")).toBeLessThan(text.indexOf("Car registration"));
    expect(text.indexOf("Car registration")).toBeLessThan(text.indexOf("Lake Tahoe trip"));
    expect(within(table).getByText("In November’s plan")).toBeTruthy();
    expect(within(table).getByText("$2,400.00")).toBeTruthy();
  });

  it("opens on the goal that is behind, with its suggestion and the paydays math", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    await within(aside()).findByText("Result");
    expect(within(aside()).getByRole("heading", { name: "Lake Tahoe trip" })).toBeTruthy();
    expect(within(aside()).getByRole("button", { name: "Use $313 a month to stay on track" })).toBeTruthy();
    expect(within(aside()).getByText("4 paydays × $250")).toBeTruthy();
    expect(within(aside()).getByText("By target date")).toBeTruthy();
    expect(
      screen.getByText("Transfers are reminders on Sam’s payday. You move the money yourselves."),
    ).toBeTruthy();
  });

  it("shows a stepper and no suggestion for a goal that is on track", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("radio", { name: /Emergency fund/ }));
    await waitFor(() =>
      expect(within(aside()).getByRole("heading", { name: "Emergency fund" })).toBeTruthy(),
    );
    await within(aside()).findByText("Reached Oct 2027");
    expect(within(aside()).getByText("Target $10,000 · no deadline")).toBeTruthy();
    expect(within(aside()).getByRole("group", { name: "Monthly deposit" })).toBeTruthy();
    expect(within(aside()).queryByText(/to stay on track/)).toBeNull();
  });

  it("steps Tahoe by $25, updates the total live, and suggests $313", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("radio", { name: /Lake Tahoe trip/ }));
    const a = await waitFor(() => {
      const el = aside();
      expect(within(el).getByRole("heading", { name: "Lake Tahoe trip" })).toBeTruthy();
      return el;
    });
    await within(a).findByText("−$250");
    expect(within(a).getByRole("button", { name: "Ask Jordan to approve" }).hasAttribute("disabled")).toBe(
      true,
    );
    await userEvent.click(within(a).getByRole("button", { name: "Increase by $25" }));
    await waitFor(() => expect(screen.getByText("$575")).toBeTruthy());
    expect(within(a).getByRole("button", { name: "Ask Jordan to approve" }).hasAttribute("disabled")).toBe(
      false,
    );
    await userEvent.click(within(a).getByRole("button", { name: "Use $313 a month to stay on track" }));
    await within(a).findByText("On track");
    expect(within(aside()).queryByText(/to stay on track/)).toBeNull();
    expect(screen.getByText("$613")).toBeTruthy();
  });

  it("asks the partner to approve instead of applying the change", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("radio", { name: /Lake Tahoe trip/ }));
    await within(aside()).findByText("−$250");
    await userEvent.click(within(aside()).getByRole("button", { name: "Use $313 a month to stay on track" }));
    await userEvent.click(within(aside()).getByRole("button", { name: "Ask Jordan to approve" }));
    await within(aside()).findByText(/Waiting for Jordan to approve \$313 a month for Lake Tahoe trip/);
    // The saved plan did not change.
    expect(screen.getByText("$550")).toBeTruthy();
    expect(within(screen.getByRole("radiogroup", { name: "Goals" })).getByText("$250 behind")).toBeTruthy();
  });

  it("creates a goal; its monthly amount waits for approval", async () => {
    renderApp(<GoalsScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "New goal" }));
    await userEvent.type(screen.getByLabelText("Name"), "New couch");
    await userEvent.type(screen.getByLabelText("Target"), "1,200");
    await userEvent.type(screen.getByLabelText("Per month"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Create goal" }));
    const banner = await screen.findByText(/New couch is created\. Its \$100 a month is waiting for Jordan/);
    expect(banner).toBeTruthy();
    expect(await screen.findByRole("radio", { name: /New couch/ })).toBeTruthy();
  });

  it("shows an error banner when goals fail", async () => {
    renderApp(<GoalsScreen />);
    setFault("goals", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t load your goals.");
  });

  it("shows the empty state for a new household", async () => {
    renderApp(<GoalsScreen />, { scenario: "empty" });
    await screen.findByText(/No goals yet/);
  });
});

describe("parseDollars", () => {
  it("reads whole and fractional dollars as integer cents", () => {
    expect(parseDollars("2,400")).toBe(240000);
    expect(parseDollars("$1,200.5")).toBe(120050);
    expect(parseDollars("0.99")).toBe(99);
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
  });
});
