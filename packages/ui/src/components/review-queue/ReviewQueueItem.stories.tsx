import type { Meta, StoryObj } from "@storybook/react-vite";
import { Temporal } from "@js-temporal/polyfill";
import { useState } from "react";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { EmptyState, StatusBanner } from "../states/States";
import { ReviewQueueItem } from "./ReviewQueueItem";
import type { ReviewQueueItemProps } from "./ReviewQueueItem";

const today = Temporal.PlainDate.from(fixture.today);
const noop = () => {};

const ELECTRICITY: ReviewQueueItemProps = {
  title: "Electricity bill: actual amount",
  tag: { variant: "info", label: "Updates existing" },
  sender: "Riverside Power",
  subject: "Your October statement is ready",
  receivedOn: Temporal.PlainDate.from("2026-10-26"),
  today,
  fields: [
    { label: "Amount", value: { cents: 15137 } },
    { label: "Due", value: { date: Temporal.PlainDate.from("2026-11-03") } },
    { label: "Account", value: { text: "•••2290" } },
    { label: "Replaces", value: { cents: 14200, mode: "estimate" } },
  ],
  effect: "Electricity set to $151.37. Safe to spend is now $998.",
  onConfirm: noop,
  onEdit: noop,
  onIgnore: noop,
};

const meta = {
  title: "Components/ReviewQueueItem",
  component: ReviewQueueItem,
  args: ELECTRICITY,
  decorators: [(Story) => <div style={{ maxWidth: "720px" }}>{Story()}</div>],
} satisfies Meta<typeof ReviewQueueItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UpdatesExisting: Story = {};
export const NewRenewal: Story = {
  args: {
    title: "Renters insurance renewal",
    tag: { variant: "ok", label: "New renewal" },
    sender: "Northgate Home Insurance",
    subject: "Your policy renews Jan 9",
    fields: [
      { label: "Amount", value: { cents: 16800 } },
      { label: "Renews", value: { date: Temporal.PlainDate.from("2027-01-09") } },
      { label: "Policy", value: { text: "•••4821" } },
    ],
    effect: "Adds a yearly renewal with reminders 30 and 7 days before.",
  },
};
export const NeedsDecision: Story = {
  args: {
    title: "Health plan enrollment",
    tag: { variant: "attention", label: "Needs a decision" },
    sender: "Jordan’s employer plan",
    subject: "Open enrollment closes Nov 13",
    fields: [
      { label: "Decide by", value: { date: Temporal.PlainDate.from("2026-11-13") } },
      { label: "Per paycheck", value: { cents: 24800 } },
    ],
    effect: "Adds a task for Jordan due Nov 13.",
  },
};
export const Busy: Story = { args: { busy: true } };

/** After an action the item disappears and a status banner says what changed (§4). */
function QueueDemo() {
  const [done, setDone] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--mp-space-3)" }}>
      {done && <StatusBanner>{done}</StatusBanner>}
      {done ? (
        <EmptyState>All caught up. New bills and renewals will appear here as they arrive.</EmptyState>
      ) : (
        <ReviewQueueItem
          {...ELECTRICITY}
          onConfirm={() => setDone("Electricity set to $151.37. Safe to spend is now $998.")}
          onIgnore={() => setDone("Ignored. Nothing changed.")}
        />
      )}
    </div>
  );
}

export const AfterAction: Story = { render: () => <QueueDemo /> };
