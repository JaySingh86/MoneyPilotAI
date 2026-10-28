import { Temporal } from "@js-temporal/polyfill";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { CalendarCell, EventChip } from "./Calendar";
import type { EventChipProps } from "./Calendar";

const nov4 = Temporal.PlainDate.from("2026-11-04");
const insurance: EventChipProps = {
  kind: "decision",
  owner: "partnerB",
  name: "Car insurance",
  amountCents: -68400,
};

describe("EventChip", () => {
  it("shows the owner dot, name and signed chip amount (whole dollars at $100 or more)", () => {
    const { container } = render(
      <>
        <EventChip {...insurance} />
        <EventChip kind="income" owner="partnerA" name="Sam’s pay" amountCents={315000} />
        <EventChip kind="bill" owner="partnerB" name="Internet" amountCents={-7000} />
        <EventChip kind="estimate" owner="partnerA" name="Electricity" amountCents={-14200} />
        <EventChip kind="bill" owner="partnerA" name="Streaming" amountCents={-2299} />
      </>,
    );
    const chips = [...container.querySelectorAll("[data-kind]")].map((c) => c.textContent);
    expect(chips).toEqual([
      "Car insurance−$684",
      "Sam’s pay+$3,150",
      "Internet−$70",
      "Electricity~−$142",
      "Streaming−$22.99",
    ]);
  });
});

describe("CalendarCell", () => {
  it("is a button labelled with the day and item count, pressed when selected", async () => {
    const onSelect = vi.fn();
    render(<CalendarCell date={nov4} events={[insurance]} selected onSelect={onSelect} />);
    const cell = screen.getByRole("button", { name: "November 4, 1 item" });
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(cell);
    expect(onSelect).toHaveBeenCalledWith(nov4);
  });

  it("marks paydays in text and in its label", () => {
    render(
      <CalendarCell
        date={Temporal.PlainDate.from("2026-11-06")}
        events={[{ kind: "income", owner: "partnerA", name: "Sam’s pay", amountCents: 315000 }]}
        payday
      />,
    );
    expect(screen.getByRole("button", { name: "November 6, payday, 1 item" })).toBeTruthy();
    expect(screen.getByText("Payday")).toBeTruthy();
  });

  it("shows up to 3 chips, then +N more", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...insurance, name: `Bill ${i}` }));
    render(<CalendarCell date={nov4} events={events} />);
    expect(screen.getByText("+2 more")).toBeTruthy();
    expect(screen.queryByText("Bill 3")).toBeNull();
    expect(screen.getByRole("button", { name: "November 4, 5 items" })).toBeTruthy();
  });

  it("can't select days outside the month", () => {
    render(<CalendarCell date={Temporal.PlainDate.from("2026-12-01")} events={[]} outsideMonth />);
    const cell = screen.getByRole("button", { name: "December 1" }) as HTMLButtonElement;
    expect(cell.disabled).toBe(true);
    expect(cell.hasAttribute("aria-pressed")).toBe(false);
  });

  it("has no axe violations", async () => {
    const { container } = render(<CalendarCell date={nov4} events={[insurance]} selected />);
    await expectNoAxeViolations(container);
  });
});
