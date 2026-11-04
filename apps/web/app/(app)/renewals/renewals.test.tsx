// Subscriptions & renewals renders the renewals golden values, the radar and the table (WP-18).
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setFault } from "../../../mocks/state";
import { renderApp } from "../../../test/render";
import { RenewalsScreen } from "./RenewalsScreen";

async function loaded() {
  await screen.findByRole("table", { name: "Everything that renews" });
}

describe("Subscriptions & renewals", () => {
  it("shows the four KPI tiles with the golden values", async () => {
    renderApp(<RenewalsScreen />);
    await loaded();
    expect(screen.getByText("$6,787.27")).toBeTruthy();
    expect(screen.getByText("16 items · about $566 a month")).toBeTruthy();
    expect(screen.getByText("$1,040.99")).toBeTruthy();
    expect(screen.getByText("4 payments + 1 plan decision")).toBeTruthy();
    expect(screen.getByText("+$55 / yr")).toBeTruthy();
    expect(screen.getByText("Streaming bundle and renters insurance")).toBeTruthy();
    expect(screen.getByText("$181.87 / yr")).toBeTruthy();
    expect(screen.getByText("If you drop the 2 you flagged as unused")).toBeTruthy();
  });

  it("draws the radar with five cards, attention for decisions", async () => {
    renderApp(<RenewalsScreen />);
    await loaded();
    const radar = screen.getByRole("region", { name: "Renewal radar · next 90 days" });
    const cards = within(radar).getAllByRole("listitem");
    expect(cards).toHaveLength(5);
    expect(within(radar).getByText("Nov 4 · in 8 days")).toBeTruthy();
    expect(within(radar).getByText("Nov 13 · decide")).toBeTruthy();
    expect(within(radar).getByText("Dec 1 · cancel by Nov 30")).toBeTruthy();
    expect(within(radar).getByText("Jan 9, 2027 · up $19")).toBeTruthy();
    expect(within(radar).getByText("$684 · 6 months · Jordan")).toBeTruthy();
  });

  it("lists 16 renewals sorted by next action with category counts", async () => {
    renderApp(<RenewalsScreen />);
    await loaded();
    const table = screen.getByRole("table", { name: "Everything that renews" });
    expect(within(table).getAllByRole("row")).toHaveLength(17);
    const pills = screen.getByRole("group", { name: "Filter by type" });
    expect(within(pills).getByRole("button", { name: /^All 16/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Insurance 5/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Subscriptions 8/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Memberships 2/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Vehicle & home 1/ })).toBeTruthy();
    expect(within(table).getByText("Decide by Nov 13")).toBeTruthy();
    expect(within(table).getByText("Cancel by Nov 30?")).toBeTruthy();
    expect(within(table).getByText("Not automatic")).toBeTruthy();
    await userEvent.click(within(pills).getByRole("button", { name: /^Memberships/ }));
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("selects Renters insurance and shows its detail", async () => {
    renderApp(<RenewalsScreen />);
    await loaded();
    const aside = screen.getByRole("complementary", { name: "Selected renewal" });
    expect(within(aside).getByRole("heading", { name: "Renters insurance" })).toBeTruthy();
    expect(within(aside).getAllByText("$168.00")).toHaveLength(2); // the cost and the cost per year
    expect(within(aside).getByText("Jan 9, 2027 · in 74 days")).toBeTruthy();
    expect(within(aside).getByText("Shop around by Dec 10")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Car registration" }));
    const next = screen.getByRole("complementary", { name: "Selected renewal" });
    expect(within(next).getByText("No, renew it yourself")).toBeTruthy();
  });

  it("shows an error and keeps the page header when renewals fail", async () => {
    renderApp(<RenewalsScreen />);
    setFault("renewals", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t load your renewals.");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Subscriptions & renewals");
  });
});
