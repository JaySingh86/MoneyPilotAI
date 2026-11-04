// The Overview renders every golden value on the canvas, in both states, and its loading, empty and
// error states (WP-17).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../../test/render";
import { setFault } from "../../../mocks/state";
import { OverviewScreen } from "./OverviewScreen";

async function loaded() {
  await screen.findByText("Cash runway to payday");
}

describe("Overview, on track", () => {
  it("shows the hero, KPI tiles and header golden values", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("10 days to payday. Here’s the plan.");
    expect(screen.getByText("Tuesday, October 27")).toBeTruthy();
    expect(screen.getByText("Safe to spend until Fri, Nov 6")).toBeTruthy();
    expect(screen.getByText("≈ $100 a day for 10 days")).toBeTruthy();
    const hero = screen.getByRole("region", { name: "Safe to spend until Fri, Nov 6" });
    expect(within(hero).getByText("$1,007", { selector: "span" })).toBeTruthy();
    expect(hero.textContent).toContain("Lowest projected balance $1,507 on Nov 5");
    expect(hero.textContent).toContain("Cushion $500");
    // Bills and income tiles.
    expect(screen.getAllByText("$4,792.99")).toHaveLength(2); // the tile and the table total
    expect(screen.getByText("8 bills · Sam owns 4, Jordan owns 4")).toBeTruthy();
    expect(screen.getByText("$1,793.99")).toBeTruthy();
    expect(screen.getByText("$2,999.00")).toBeTruthy();
    expect(screen.getByText("$2,900.00")).toBeTruthy();
    expect(screen.getByText("Fri, Oct 30 · Jordan’s paycheck")).toBeTruthy();
    expect(screen.getByText("Next: Sam’s paycheck $3,150 on Nov 6, then $550 to goals")).toBeTruthy();
  });

  it("draws the runway with the lowest day and the cushion", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    expect(screen.getByText("Lowest · $1,507")).toBeTruthy();
    expect(screen.getByText("$500 cushion")).toBeTruthy();
    const rows = within(
      screen.getByRole("table", { name: "Projected end-of-day balance to payday" }),
    ).getAllByRole("row");
    expect(rows).toHaveLength(12);
  });

  it("lists the eight bills with chips and the total, and recalculates it per owner", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    const table = screen.getByRole("table", { name: "Bills due before payday" });
    expect(within(table).getAllByRole("row")).toHaveLength(10);
    expect(within(table).getByText("Price up $3")).toBeTruthy();
    expect(within(table).getByText("Estimate ±$30")).toBeTruthy();
    expect(within(table).getByText("Not usual month")).toBeTruthy();
    expect(within(table).getByText("~$142.00")).toBeTruthy();
    expect(within(table).getByText("Total due before Nov 6")).toBeTruthy();
    expect(within(table).getAllByText("$4,792.99")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Sam" }));
    expect(within(table).getByText("$1,793.99")).toBeTruthy();
    expect(within(table).queryByText("Rent")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Jordan" }));
    expect(within(table).getByText("$2,999.00")).toBeTruthy();
  });

  it("shows the three Decide this week cards with the golden text", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    expect(screen.getByText("3 items")).toBeTruthy();
    expect(screen.getByText("Not in your usual month · Jordan")).toBeTruthy();
    expect(screen.getByText("Car insurance renewal, $684 on Nov 4")).toBeTruthy();
    expect(
      screen.getByText(/changes safe to spend to \$1,691\. Only if your provider allows it\./),
    ).toBeTruthy();
    expect(screen.getByText("Electricity is about $142 (±$30)")).toBeTruthy();
    expect(screen.getByText(/Based on your last 3 bills \(\$118–\$171\)/)).toBeTruthy();
    expect(screen.getByText("Lake Tahoe trip is $250 behind")).toBeTruthy();
    expect(screen.getByText(/Raising it to \$313/)).toBeTruthy();
    expect(screen.getByText(/AI only writes the explanations, and nothing moves money/)).toBeTruthy();
  });

  it("shows goals, tasks and the data-source footer", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    expect(screen.getByText("64%")).toBeTruthy();
    expect(screen.getByText("48%")).toBeTruthy();
    expect(screen.getByText("53%")).toBeTruthy();
    expect(screen.getByText("$6,400 of $10,000")).toBeTruthy();
    expect(screen.getByText("$250 behind")).toBeTruthy();
    expect(screen.getByText("$300 on payday")).toBeTruthy();
    expect(await screen.findByText("Review 2 flagged subscriptions")).toBeTruthy();
    expect(
      screen.getByText("Sample data · Updated from CSV import Oct 26, 2026 · All amounts in USD"),
    ).toBeTruthy();
  });

  it("opens See the math with the engine's steps", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "See the math" }));
    const dialog = await screen.findByRole("dialog", { name: "See the math", hidden: true });
    expect(within(dialog).getByText("Lowest projected balance on Nov 5")).toBeTruthy();
    expect(within(dialog).getByText("$1,507.01")).toBeTruthy();
    expect(within(dialog).getByText("−$500.00")).toBeTruthy();
    expect(within(dialog).getByText("$1,007")).toBeTruthy();
    expect(dialog.textContent).toContain("about $100 a day");
  });

  it("opens the what-if for the car insurance card", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Plan for it" }));
    const dialog = await screen.findByRole("dialog", { name: "Plan for it", hidden: true });
    expect(within(dialog).getByText("Paying on Nov 6 instead")).toBeTruthy();
    expect(within(dialog).getByText("$1,691")).toBeTruthy();
    expect(dialog.textContent).toContain("Only if your provider allows it");
  });
});

describe("Overview, shortfall", () => {
  it("shows the shortfall hero, negative runway and ways to cover the gap", async () => {
    renderApp(<OverviewScreen />, { scenario: "shortfall" });
    await loaded();
    expect(screen.getByText("Short before Fri, Nov 6")).toBeTruthy();
    expect(screen.getByText("Needs a decision", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("$793 short")).toBeTruthy();
    expect(screen.getByText("Below your cushion from Nov 3, below $0 on Nov 4–5")).toBeTruthy();
    const hero = screen.getByRole("region", { name: "Short before Fri, Nov 6" });
    expect(hero.textContent).toContain("Lowest projected balance −$293 on Nov 5");
    expect(hero.textContent).toContain("−$793");
    expect(screen.getByText("Lowest · −$293")).toBeTruthy();

    const cover = screen.getByRole("region", { name: "Ways to cover the gap" });
    expect(within(cover).getByText("Move $1,300 from the Emergency fund")).toBeTruthy();
    expect(
      within(cover).getByText("The fund drops to $5,100. Reaching $10,000 moves from Oct 2027 to Mar 2028."),
    ).toBeTruthy();
    expect(within(cover).getByText("$507 safe to spend")).toBeTruthy();
    expect(within(cover).getByText("$107 safe to spend")).toBeTruthy();
    expect(within(cover).getByText("$109 short, never below $0")).toBeTruthy();
    expect(within(cover).getByText(/\$900 now, \$900 after Nov 6/)).toBeTruthy();
    expect(within(cover).getByText("Only if your insurer allows it")).toBeTruthy();
    // The shortfall is the first Decide this week card.
    expect(screen.getByText("Short $793 before Nov 6")).toBeTruthy();
    expect(screen.getByText("4 items")).toBeTruthy();
    // The planned expense is in the table and the total.
    expect(screen.getByText("Car repair")).toBeTruthy();
    expect(screen.getByText("$6,592.99", { selector: "td" })).toBeTruthy();
  });

  it("never offers an action that moves money", async () => {
    renderApp(<OverviewScreen />, { scenario: "shortfall" });
    await loaded();
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(labels.filter((l) => /^(pay|transfer|send)\b/i.test(l))).toEqual([]);
  });
});

describe("Overview, other states", () => {
  it("shows empty states for a new household", async () => {
    renderApp(<OverviewScreen />, { scenario: "empty" });
    await loaded();
    expect(screen.getByText(/All caught up\. New bills and renewals will appear here/)).toBeTruthy();
    expect(screen.getByText(/Nothing is due before payday/)).toBeTruthy();
    expect(screen.getByText(/No goals yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing is due this week/)).toBeTruthy();
  });

  it("shows the loading skeleton, then the plan", async () => {
    renderApp(<OverviewScreen />);
    // Skeletons appear after 300 ms (§5.3); the polite status is there from the start.
    expect(document.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    await loaded();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("keeps the last plan on screen under the banner when a refresh fails", async () => {
    const { queryClient } = renderApp(<OverviewScreen />);
    await loaded();
    setFault("plan", true);
    await queryClient.refetchQueries({ queryKey: ["plan"] });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t refresh your plan.");
    expect(alert.textContent).toContain("The numbers below are the last ones we loaded.");
    // The cached plan is still there.
    expect(screen.getByText("Cash runway to payday")).toBeTruthy();
    expect(screen.getByText("Car insurance renewal, $684 on Nov 4")).toBeTruthy();
    setFault("plan", false);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says nothing is shown when the first load fails", async () => {
    renderApp(<OverviewScreen />);
    setFault("plan", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No numbers are shown until it loads.");
    expect(screen.queryByText("Cash runway to payday")).toBeNull();
  });

  it("saves a task when it is checked, through the tasks API", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(4));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.some((b) => b.disabled)).toBe(false);
    expect(boxes.filter((b) => b.checked)).toHaveLength(1);
    await userEvent.click(screen.getByRole("checkbox", { name: /Review 2 flagged subscriptions/ }));
    // Saved: it leaves "due this week" (the list refetched from the API).
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: /Review 2 flagged subscriptions/ })).toBeNull(),
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("shows target dates with the year when it isn't the current one (§7)", async () => {
    renderApp(<OverviewScreen />);
    await loaded();
    expect(screen.getByText("Lake Tahoe trip · Mar 1, 2027")).toBeTruthy();
    expect(screen.getByText("Holiday gifts · Dec 15")).toBeTruthy();
    expect(
      screen.getByText(/by Mar 1, 2027\. Raising it to \$313 or moving the date to Apr 1, 2027/),
    ).toBeTruthy();
  });

  it("shows an error banner with a retry link that recovers", async () => {
    renderApp(<OverviewScreen />);
    setFault("plan", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t load your plan.");
    setFault("plan", false);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Cash runway to payday")).toBeTruthy());
  });
});
