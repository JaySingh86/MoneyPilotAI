import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Checkbox, SelectField, TextField } from "./Field";

const meta = {
  title: "Components/Input & select",
  component: TextField,
  args: { label: "Task" },
  decorators: [(Story) => <div style={{ maxWidth: "320px" }}>{Story()}</div>],
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = { args: { label: "Task", placeholder: "Call the insurer" } };
export const Money: Story = { args: { label: "Amount", money: true, placeholder: "$0.00" } };
export const WithHint: Story = {
  args: {
    label: "Cushion",
    money: true,
    defaultValue: "500.00",
    hint: "Kept aside, never counted as safe to spend",
  },
};
export const WithError: Story = {
  args: { label: "Amount", money: true, defaultValue: "15o.00", error: "Enter an amount like 151.37" },
};
export const Disabled: Story = {
  args: { label: "Forwarding address", defaultValue: "rivera-7k2@in.moneypilot.app", disabled: true },
};

export const Select: Story = {
  render: () => (
    <SelectField
      label="Owner"
      defaultValue="both"
      options={[
        { value: "sam", label: "Sam" },
        { value: "jordan", label: "Jordan" },
        { value: "both", label: "Both" },
      ]}
    />
  ),
};

export const SelectWithError: Story = {
  render: () => (
    <SelectField
      label="Primary income"
      error="Choose the paycheck that sets your payday"
      defaultValue=""
      options={[
        { value: "", label: "Choose…" },
        { value: "inc-sam", label: "Sam’s pay" },
        { value: "inc-jordan", label: "Jordan’s pay" },
      ]}
    />
  ),
};

function CheckboxDemo({ initial }: { initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  return (
    <Checkbox
      label="Compare car insurance quotes"
      checked={checked}
      strikeWhenChecked
      onChange={(e) => setChecked(e.target.checked)}
    />
  );
}

export const CheckboxOpen: Story = { render: () => <CheckboxDemo initial={false} /> };
export const CheckboxDone: Story = { render: () => <CheckboxDemo initial /> };
