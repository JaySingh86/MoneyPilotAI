import type { Meta, StoryObj } from "@storybook/react-vite";
import { Temporal } from "@js-temporal/polyfill";
import { useState } from "react";
import type { CalendarDate } from "../internal/types";
import { CalendarCell, EventChip } from "./Calendar";
import type { EventChipProps } from "./Calendar";

const d = (iso: string) => Temporal.PlainDate.from(iso);

// Fixture items on these November days (owner roles: Sam = partnerA, Jordan = partnerB).
const NOV_2: EventChipProps[] = [
  { kind: "bill", owner: "partnerA", name: "Daycare", amountCents: -124000 },
  { kind: "decision", owner: "partnerA", name: "Streaming bundle", amountCents: -2299 },
];
const NOV_3: EventChipProps[] = [
  { kind: "estimate", owner: "partnerA", name: "Electricity", amountCents: -14200 },
];
const NOV_4: EventChipProps[] = [
  { kind: "decision", owner: "partnerB", name: "Car insurance", amountCents: -68400 },
];
const NOV_6: EventChipProps[] = [
  { kind: "income", owner: "partnerA", name: "Sam’s pay", amountCents: 315000 },
];
const NOV_26: EventChipProps[] = [
  { kind: "planned", owner: "both", name: "Thanksgiving", amountCents: -25000 },
];
const BUSY: EventChipProps[] = [
  ...NOV_2,
  { kind: "bill", owner: "partnerB", name: "Internet", amountCents: -7000 },
  { kind: "bill", owner: "partnerB", name: "News", amountCents: -800 },
  { kind: "bill", owner: "partnerA", name: "Cloud storage", amountCents: -299 },
];

function Cell(props: {
  date: CalendarDate;
  events: EventChipProps[];
  payday?: boolean;
  outsideMonth?: boolean;
  initiallySelected?: boolean;
}) {
  const [selected, setSelected] = useState(props.initiallySelected ?? false);
  return (
    <div style={{ width: "150px" }}>
      <CalendarCell
        date={props.date}
        events={props.events}
        payday={props.payday}
        outsideMonth={props.outsideMonth}
        selected={selected}
        onSelect={() => setSelected(true)}
      />
    </div>
  );
}

const meta = {
  title: "Components/Calendar",
  component: Cell,
  args: { date: d("2026-11-04"), events: NOV_4 },
} satisfies Meta<typeof Cell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { date: d("2026-11-03"), events: NOV_3 } };
export const Selected: Story = { args: { initiallySelected: true } };
export const Payday: Story = { args: { date: d("2026-11-06"), events: NOV_6, payday: true } };
export const PaydaySelected: Story = {
  args: { date: d("2026-11-06"), events: NOV_6, payday: true, initiallySelected: true },
};
export const MoreThanThree: Story = { args: { date: d("2026-11-02"), events: BUSY } };
export const Empty: Story = { args: { date: d("2026-11-10"), events: [] } };
export const OutsideMonth: Story = { args: { date: d("2026-12-01"), events: [], outsideMonth: true } };

export const EventChips: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--mp-space-1)", width: "180px" }}>
      <EventChip {...NOV_6[0]!} />
      <EventChip kind="bill" owner="partnerB" name="Rent" amountCents={-215000} />
      <EventChip {...NOV_3[0]!} />
      <EventChip {...NOV_4[0]!} />
      <EventChip {...NOV_26[0]!} />
    </div>
  ),
};
