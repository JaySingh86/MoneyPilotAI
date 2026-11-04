// Household tasks: golden groups, saving through the tasks API, adding a task, filters (WP-18).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setFault } from "../../../mocks/state";
import { renderApp } from "../../../test/render";
import { TasksScreen } from "./TasksScreen";

async function loaded() {
  await screen.findByRole("region", { name: "Due this week" });
}
const group = (name: string) => screen.getByRole("region", { name });

describe("Household tasks", () => {
  it("shows 3 due this week, 4 later and 3 done", async () => {
    renderApp(<TasksScreen />);
    await loaded();
    expect(within(group("Due this week")).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(group("Later")).getAllByRole("checkbox")).toHaveLength(4);
    expect(within(group("Done")).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(group("Due this week")).getByText("3 tasks")).toBeTruthy();
    expect(
      within(group("Done"))
        .getAllByRole("checkbox")
        .every((c) => (c as HTMLInputElement).checked),
    ).toBe(true);
  });

  it("words each row's due date, link and source", async () => {
    renderApp(<TasksScreen />);
    await loaded();
    const week = group("Due this week");
    expect(within(week).getByText("Fri, Oct 30")).toBeTruthy();
    expect(within(week).getByText("When the bill arrives, about Nov 1")).toBeTruthy();
    expect(within(week).getByText("Electricity")).toBeTruthy();
    expect(within(week).getByText(/Suggested by MoneyPilot · completes itself/)).toBeTruthy();
    expect(within(group("Later")).getAllByText("From email")).toHaveLength(2);
    expect(within(group("Later")).getAllByText("Renewal reminder")).toHaveLength(2);
    expect(within(week).getByText("Added by Sam")).toBeTruthy();
  });

  it("saves a checked task through the API and moves it to Done", async () => {
    renderApp(<TasksScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("checkbox", { name: "Review 2 flagged subscriptions" }));
    await waitFor(() => expect(within(group("Due this week")).getAllByRole("checkbox")).toHaveLength(2));
    expect(
      within(group("Done")).getByRole("checkbox", { name: "Review 2 flagged subscriptions" }),
    ).toBeTruthy();
    // A reload of the list (a new query) still shows it done: it was saved, not just drawn.
    await userEvent.click(screen.getByRole("button", { name: "Sam" }));
    await userEvent.click(screen.getByRole("button", { name: "Jordan" }));
    expect(
      within(group("Done")).getByRole("checkbox", { name: "Review 2 flagged subscriptions" }),
    ).toBeTruthy();
  });

  it("filters by owner, keeping Both tasks, and counts open tasks per owner", async () => {
    renderApp(<TasksScreen />);
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Jordan" }));
    expect(within(group("Due this week")).getAllByRole("checkbox")).toHaveLength(2); // Both + Jordan's
    expect(within(group("Later")).queryByRole("checkbox", { name: "Renew car registration" })).toBeNull();
    const open = screen.getByRole("region", { name: "Open tasks" });
    expect(
      within(open)
        .getAllByText(/^\d+$/)
        .map((n) => n.textContent),
    ).toEqual(["4", "2", "1"]);
  });

  it("adds a task and clears the field", async () => {
    renderApp(<TasksScreen />);
    await loaded();
    await userEvent.type(screen.getByLabelText("New task"), "Call the insurer");
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("checkbox", { name: "Call the insurer" });
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("");
  });

  it("shows an error banner when tasks fail", async () => {
    renderApp(<TasksScreen />);
    setFault("tasks", true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn’t load your tasks.");
  });

  it("shows the dashed empty state in each group for a new household", async () => {
    renderApp(<TasksScreen />, { scenario: "empty" });
    await screen.findByText("Nothing due this week.");
    expect(screen.getByText("Nothing scheduled later.")).toBeTruthy();
    expect(screen.getByText("Finished tasks show up here.")).toBeTruthy();
  });
});
