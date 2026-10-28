import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bell, ChevronLeft, ChevronRight, Plus, Upload } from "lucide-react";
import { Button, IconButton } from "./Button";

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Add bill or income" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary", icon: Plus } };
export const Secondary: Story = { args: { variant: "secondary", icon: Upload, children: "Import CSV" } };
export const SecondaryInPageHeader: Story = {
  args: { variant: "secondary", inHeader: true, icon: Upload, children: "Import CSV" },
};
export const Text: Story = { args: { variant: "text", children: "See the math" } };
export const Destructive: Story = {
  render: () => <Button variant="destructive" label="Delete household…" />,
};
export const Disabled: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--mp-space-2)", flexWrap: "wrap" }}>
      <Button disabled>Add bill or income</Button>
      <Button variant="secondary" disabled>
        Import CSV
      </Button>
      <Button variant="text" disabled>
        See the math
      </Button>
      <Button variant="destructive" label="Leave…" disabled />
    </div>
  ),
};
export const Compact: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--mp-space-2)" }}>
      <Button size="compact">Review</Button>
      <Button size="compact" variant="secondary">
        Ask Jordan
      </Button>
    </div>
  ),
};
export const Mobile: Story = { args: { size: "mobile", children: "Mark as paid" } };
export const MobileBottomBar: Story = {
  args: { size: "mobileBar", children: "Mark as paid" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const Icon: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--mp-space-2)", alignItems: "center" }}>
      <IconButton icon={Bell} label="Notifications" />
      <IconButton icon={Bell} label="Notifications, 2 new" notification />
      <IconButton icon={ChevronLeft} label="Previous month" shape="mobile" />
      <IconButton icon={ChevronRight} label="Next month" shape="mobile" />
      <IconButton icon={Plus} label="Add renewal" disabled />
    </div>
  ),
};
