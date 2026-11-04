// Bills & recurring renders the billsPage golden values, the canvas rows and chips, and its states (WP-18).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setFault } from "../../../mocks/state";
import { renderApp } from "../../../test/render";
import { BillsScreen } from "./BillsScreen";
import { reminderText } from "./derive";

async function loaded() {
  await screen.findByRole("table", { name: "Bills and income that repeat" });
}

describe("Bills & recurring", () => {
  it("shows the four KPI tiles with the golden values", async () => {
    renderApp(<BillsScreen />);
    await loaded();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Bills & recurring");
    expect(
      screen.getByText("16 bills and 2 paychecks. Each one has an owner, a schedule and reminders."),
    ).toBeTruthy();
    expect(screen.getByText("$4,956.94")).toBeTruthy();
    expect(screen.getByText("$9,725.00")).toBeTruthy();
    expect(screen.getByText("$4,768.06")).toBeTruthy();
    expect(screen.getByText("Sam every other Friday, Jordan monthly")).toBeTruthy();
    expect(screen.getByText("Electricity and credit card")).toBeTruthy();
    const estimates = screen.getByText("Estimates to confirm").parentElement;
    expect(estimates?.textContent).toContain("2");
  });

  it("lists 18 rows by next date with status chips and income in plus", async () => {
    renderApp(<BillsScreen />);
    await loaded();
    const table = screen.getByRole("table", { name: "Bills and income that repeat" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(19);
    // Sorted by next date: Car payment (Oct 29) first.
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "Car payment" })).toBeTruthy();
    expect(within(table).getByText("Price up $3")).toBeTruthy();
    expect(within(table).getByText("Not usual month")).toBeTruthy();
    expect(within(table).getByText("Estimate ±$30")).toBeTruthy();
    expect(within(table).getByText("Sets payday")).toBeTruthy();
    expect(within(table).getByText("Possible duplicate")).toBeTruthy();
    expect(within(table).getByText("+$2,900.00")).toBeTruthy();
    expect(within(table).getByText("~$142.00")).toBeTruthy();
  });

  it("filters by type pill and owner, with counts", async () => {
    renderApp(<BillsScreen />);
    await loaded();
    const pills = screen.getByRole("group", { name: "Filter by type" });
    expect(within(pills).getByRole("button", { name: /^Bills 16/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Income 2/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Subscriptions 7/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /^Estimates 2/ })).toBeTruthy();
    await userEvent.click(within(pills).getByRole("button", { name: /^Income/ }));
    const table = screen.getByRole("table", { name: "Bills and income that repeat" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    await userEvent.click(
      within(screen.getByRole("group", { name: "Filter by owner" })).getByRole("button", { name: "Jordan" }),
    );
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("selects Electricity by default and explains its estimate", async () => {
    renderApp(<BillsScreen />);
    await loaded();
    const aside = screen.getByRole("complementary", { name: "Selected bill" });
    expect(within(aside).getByRole("heading", { name: "Electricity" })).toBeTruthy();
    expect(within(aside).getByText("Monthly · 3rd · varies")).toBeTruthy();
    await waitFor(() => expect(within(aside).getByText("Aug $118")).toBeTruthy());
    expect(within(aside).getByText("Sep $171")).toBeTruthy();
    expect(within(aside).getByText("Oct $137")).toBeTruthy();
    expect(within(aside).getByText("Estimate ~$142.00 ±$30")).toBeTruthy();
    expect(within(aside).getByText("Oct 3 · $137.00")).toBeTruthy();
    expect(within(aside).getByText("Nov 3 · in 7 days")).toBeTruthy();
    expect(within(aside).getByRole("button", { name: "Mark as paid" })).toBeTruthy();
    expect(aside.textContent).not.toMatch(/\bPay now\b|Transfer|Send money/);
  });

  it("switches the detail to income with Mark as received", async () => {
    renderApp(<BillsScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Sam’s pay" }));
    const aside = screen.getByRole("complementary", { name: "Selected bill" });
    expect(within(aside).getByRole("button", { name: "Mark as received" })).toBeTruthy();
    expect(within(aside).getByText("Every other Friday")).toBeTruthy();
  });

  it("marks a bill paid, which only records it, and can undo", async () => {
    renderApp(<BillsScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Mark as paid" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Electricity marked as paid");
    await userEvent.click(within(status).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.queryByText(/marked as paid/)).toBeNull());
  });

  it("shows an error with what still works when the items fail", async () => {
    renderApp(<BillsScreen />);
    setFault("items", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t load your bills.");
  });

  it("shows the empty state for a new household", async () => {
    renderApp(<BillsScreen />, { scenario: "empty" });
    await loaded();
    expect(
      screen.getByText("0 bills and 2 paychecks. Each one has an owner, a schedule and reminders."),
    ).toBeTruthy();
  });
});

describe("reminders", () => {
  it("words the offsets", () => {
    expect(reminderText([3, 0])).toBe("3 days before and on the due date");
    expect(reminderText([30, 7, 0])).toBe("30 and 7 days before, and on the day");
  });
});
