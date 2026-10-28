import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SegmentedControl } from "./SegmentedControl";

type Owner = "both" | "sam" | "jordan";
const OWNERS = [
  { value: "both", label: "Both" },
  { value: "sam", label: "Sam" },
  { value: "jordan", label: "Jordan" },
] as const;

function Demo({
  initial = "both",
  onCanvas = false,
  density = "web",
}: {
  initial?: Owner;
  onCanvas?: boolean;
  density?: "web" | "mobile";
}) {
  const [value, setValue] = useState<Owner>(initial);
  return (
    <SegmentedControl
      label="Show items for"
      options={OWNERS}
      value={value}
      onChange={setValue}
      onCanvas={onCanvas}
      density={density}
    />
  );
}

const meta = {
  title: "Components/SegmentedControl",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnSurface: Story = {
  render: () => (
    <div style={{ background: "var(--mp-bg-surface)", padding: "var(--mp-space-4)" }}>
      <Demo />
    </div>
  ),
};
export const OnCanvas: Story = { args: { onCanvas: true } };
export const SecondSelected: Story = { args: { initial: "sam", onCanvas: true } };
export const Mobile: Story = { args: { density: "mobile", initial: "jordan", onCanvas: true } };
