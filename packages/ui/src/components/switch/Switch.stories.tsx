import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SwitchRow } from "./Switch";

function Demo({
  initial,
  disabled,
  description,
}: {
  initial: boolean;
  disabled?: boolean;
  description?: string;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <div style={{ maxWidth: "420px" }}>
      <SwitchRow
        title="3 days before"
        description={description}
        checked={checked}
        onChange={setChecked}
        disabled={disabled}
      />
    </div>
  );
}

const meta = {
  title: "Components/Switch",
  component: Demo,
  args: { initial: true },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const On: Story = {};
export const Off: Story = { args: { initial: false } };
export const WithSubLine: Story = { args: { description: "Email and push to Sam" } };
export const Disabled: Story = {
  args: { initial: false, disabled: true, description: "Turn on email first" },
};
