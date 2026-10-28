import { Temporal } from "@js-temporal/polyfill";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { ReviewQueueItem } from "./ReviewQueueItem";

function renderItem(handlers = { onConfirm: vi.fn(), onEdit: vi.fn(), onIgnore: vi.fn() }, busy = false) {
  render(
    <ReviewQueueItem
      title="Electricity bill: actual amount"
      tag={{ variant: "info", label: "Updates existing" }}
      sender="Riverside Power"
      subject="Your October statement is ready"
      receivedOn={Temporal.PlainDate.from("2026-10-26")}
      today={Temporal.PlainDate.from("2026-10-27")}
      fields={[
        { label: "Amount", value: { cents: 15137 } },
        { label: "Due", value: { date: Temporal.PlainDate.from("2026-11-03") } },
        { label: "Account", value: { text: "•••2290" } },
      ]}
      effect="Electricity set to $151.37. Safe to spend is now $998."
      busy={busy}
      {...handlers}
    />,
  );
  return handlers;
}

describe("ReviewQueueItem", () => {
  it("is an article named by its title with tag, meta line and extracted fields", () => {
    renderItem();
    const item = screen.getByRole("article", { name: "Electricity bill: actual amount" });
    expect(within(item).getByText("Updates existing")).toBeTruthy();
    expect(
      within(item).getByText("Riverside Power · “Your October statement is ready” · Oct 26"),
    ).toBeTruthy();
    expect(
      within(item)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["$151.37", "Tue, Nov 3", "•••2290"]);
  });

  it("offers Confirm, Edit and Ignore in that order, described by the item title", async () => {
    const h = renderItem();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Confirm", "Edit", "Ignore"]);
    expect(
      screen.getByRole("button", { name: "Confirm", description: "Electricity bill: actual amount" }),
    ).toBeTruthy();
    await userEvent.click(buttons[0] as HTMLElement);
    await userEvent.click(buttons[1] as HTMLElement);
    await userEvent.click(buttons[2] as HTMLElement);
    expect(h.onConfirm).toHaveBeenCalledOnce();
    expect(h.onEdit).toHaveBeenCalledOnce();
    expect(h.onIgnore).toHaveBeenCalledOnce();
  });

  it("disables actions while busy", () => {
    renderItem(undefined, true);
    for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("has no axe violations", async () => {
    renderItem();
    await expectNoAxeViolations(document.body);
  });
});
