// The Calendar shows the fixture's November, with the golden "at a glance" totals, owner filter,
// month navigation and keyboard movement through the grid (WP-17).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../../test/render";
import { setFault } from "../../../mocks/state";
import { CalendarScreen } from "./CalendarScreen";

/** Browsers put a space around flex items in an accessible name ("November 4 , Car insurance"). */
const cell = (name: string) => ({ name: (n: string) => n.replace(/\s+,/g, ",").startsWith(name) });

async function loaded() {
  await screen.findByRole("heading", { level: 1, name: "November 2026" });
}

describe("Calendar", () => {
  it("opens on November with the top decision's day selected", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    expect(screen.getByTestId("selected-day").textContent).toBe("Wednesday, Nov 4");
    const nov4 = screen.getByRole("button", cell("November 4, Car insurance renewal"));
    expect(nov4.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("This bill comes every 6 months, so it isn’t in your usual month.")).toBeTruthy();
    expect(screen.getByText("−$684.00")).toBeTruthy();
  });

  it("shows November at a glance with the golden totals", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    const glance = screen.getByRole("region", { name: "November at a glance" });
    expect(within(glance).getByText("Expected income · 3 paychecks")).toBeTruthy();
    expect(within(glance).getByText("$9,200.00")).toBeTruthy();
    expect(within(glance).getByText("Bills · 16")).toBeTruthy();
    expect(within(glance).getByText("−$5,590.94")).toBeTruthy();
    expect(within(glance).getByText("−$800.00")).toBeTruthy();
    expect(within(glance).getByText("$2,809.06")).toBeTruthy();
    expect(within(glance).getByText(/Includes 2 estimates \(electricity, credit card\)/)).toBeTruthy();
  });

  it("marks paydays and names cells from their visible content", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    expect(
      screen.getByRole("button", cell("November 6, payday, Sam’s pay +$3,150, Goal transfer −$550")),
    ).toBeTruthy();
    expect(screen.getByRole("button", cell("November 3, Electricity ~−$142"))).toBeTruthy();
    // Sam is the primary income, so his two paychecks (Nov 6 and 20) are the paydays.
    expect(screen.getAllByText("payday")).toHaveLength(2);
  });

  it("filters by owner: a partner sees their items plus Both's", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    expect(screen.getByText("Rent")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sam" }));
    await waitFor(() => expect(screen.queryByText("Rent")).toBeNull());
    expect(screen.getByText("Daycare")).toBeTruthy();
    expect(screen.getByText("Thanksgiving")).toBeTruthy();
    // Household totals don't change with the filter.
    expect(screen.getByText("$2,809.06")).toBeTruthy();
  });

  it("selects another day and explains an empty one", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", cell("November 10")));
    expect(screen.getByTestId("selected-day").textContent).toBe("Tuesday, Nov 10");
    expect(screen.getByText(/Nothing scheduled\. Pick another day/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", cell("November 2, Daycare")));
    expect(screen.getAllByText("Needs a decision").length).toBeGreaterThanOrEqual(2); // legend and day panel
    expect(screen.getByText("Price went from $19.99 to $22.99. Keep, downgrade or cancel?")).toBeTruthy();
  });

  it("moves between months", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await screen.findByRole("heading", { level: 1, name: "December 2026" });
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await screen.findByRole("heading", { level: 1, name: "October 2026" });
  });

  it("moves through the grid with the arrow keys, one tab stop at a time", async () => {
    renderApp(<CalendarScreen />);
    await loaded();
    const user = userEvent.setup();
    const nov4 = screen.getByRole("button", cell("November 4,"));
    expect(nov4.tabIndex).toBe(0);
    expect(screen.getByRole("button", cell("November 5")).tabIndex).toBe(-1);
    nov4.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-11-05");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-11-12");
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-11-04");
    await user.keyboard("{Home}");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-11-01");
    await user.keyboard("{End}");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-11-07");
    // Enter selects the focused day.
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(screen.getByTestId("selected-day").textContent).toBe("Friday, Nov 6");
    // The edge of the month stops the movement; days of other months can't be reached.
    await user.keyboard("{PageDown}");
    await screen.findByRole("heading", { level: 1, name: "December 2026" });
  });

  it("keeps the loaded month on screen under the banner when a refresh fails", async () => {
    const { queryClient } = renderApp(<CalendarScreen />);
    await loaded();
    setFault("calendar", true);
    await queryClient.refetchQueries({ queryKey: ["calendar"] });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The days below are the last ones we loaded.");
    expect(screen.getByRole("button", cell("November 4, Car insurance renewal"))).toBeTruthy();
  });

  it("shows an error banner and recovers on retry", async () => {
    renderApp(<CalendarScreen />);
    setFault("calendar", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t load the calendar.");
    setFault("calendar", false);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await loaded();
  });
});
