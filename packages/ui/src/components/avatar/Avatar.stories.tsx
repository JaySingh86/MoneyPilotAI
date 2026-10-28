import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar, AvatarStack, OwnerDot } from "./Avatar";

const meta = {
  title: "Components/Avatar",
  component: Avatar,
  args: { name: "Sam", role: "partnerA", size: 32 },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartnerA: Story = {};
export const PartnerB: Story = { args: { name: "Jordan", role: "partnerB" } };

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--mp-space-3)", alignItems: "center" }}>
      {([40, 32, 28, 24, 22] as const).map((size) => (
        <Avatar key={size} name="Jordan" role="partnerB" size={size} />
      ))}
    </div>
  ),
};

export const Stacked: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--mp-space-4)", alignItems: "center" }}>
      <AvatarStack label="Sam and Jordan" overlap="md">
        <Avatar name="Sam" role="partnerA" size={32} decorative />
        <Avatar name="Jordan" role="partnerB" size={32} decorative />
      </AvatarStack>
      <AvatarStack label="Both">
        <Avatar name="Sam" role="partnerA" size={24} decorative />
        <Avatar name="Jordan" role="partnerB" size={24} decorative />
      </AvatarStack>
    </div>
  ),
};

export const OwnerDots: Story = {
  render: () => (
    <ul style={{ display: "flex", gap: "var(--mp-space-4)", listStyle: "none", margin: 0, padding: 0 }}>
      <li style={{ display: "flex", gap: "var(--mp-space-1_5)", alignItems: "center" }}>
        <OwnerDot role="partnerA" /> Sam
      </li>
      <li style={{ display: "flex", gap: "var(--mp-space-1_5)", alignItems: "center" }}>
        <OwnerDot role="partnerB" /> Jordan
      </li>
      <li style={{ display: "flex", gap: "var(--mp-space-1_5)", alignItems: "center" }}>
        <OwnerDot role="both" /> Both
      </li>
      <li style={{ display: "flex", gap: "var(--mp-space-1_5)", alignItems: "center" }}>
        <OwnerDot role="partnerA" size={10} /> Mobile list dot
      </li>
    </ul>
  ),
};
