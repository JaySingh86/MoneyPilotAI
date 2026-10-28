import type { Meta, StoryObj } from "@storybook/react-vite";
import { estimateRange } from "@mp/format";
import { Badge, StatusChip } from "./StatusChip";

const meta = {
  title: "Components/StatusChip",
  component: StatusChip,
  args: { variant: "ok", children: "Reminder set" },
} satisfies Meta<typeof StatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ok: Story = {};
export const Income: Story = { args: { variant: "income", children: "Expected" } };
export const Attention: Story = { args: { variant: "attention", children: "Needs a decision" } };
export const Info: Story = { args: { variant: "info", children: "Not automatic" } };
export const Estimate: Story = {
  // Electricity estimate range from the fixture: ±$30.
  args: { variant: "estimate", children: estimateRange(3000, { label: true }) },
};
export const Release: Story = { args: { variant: "release", children: "MVP · P0" } };

export const NavBadge: Story = {
  render: () => <Badge count={4} label="4 to review" />,
};
