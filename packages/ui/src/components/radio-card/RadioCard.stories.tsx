import type { Meta, StoryObj } from "@storybook/react-vite";
import { Landmark, Mail, PencilLine, Upload } from "lucide-react";
import { useState } from "react";
import { StatusChip } from "../status-chip/StatusChip";
import { RadioCardGroup } from "./RadioCard";
import type { RadioCardOption } from "./RadioCard";

type Method = "email" | "csv" | "manual" | "bank";

const METHODS: ReadonlyArray<RadioCardOption<Method>> = [
  {
    value: "email",
    title: "Connect your email",
    description: "We read bills and renewals from the senders you choose.",
    icon: Mail,
    badge: <StatusChip variant="ok">Recommended</StatusChip>,
  },
  {
    value: "csv",
    title: "Import a bank CSV",
    description: "Find what repeats in your statements.",
    icon: Upload,
  },
  {
    value: "manual",
    title: "Enter manually",
    description: "Name, amount and how often it repeats.",
    icon: PencilLine,
  },
  { value: "bank", title: "Connect a bank", description: "Coming later", icon: Landmark, disabled: true },
];

function Demo({
  initial,
  layout = "column",
  hideIndicator = false,
}: {
  initial: Method | null;
  layout?: "column" | "grid";
  hideIndicator?: boolean;
}) {
  const [value, setValue] = useState<Method | null>(initial);
  return (
    <div style={{ maxWidth: layout === "grid" ? "760px" : "420px" }}>
      <RadioCardGroup
        label="How to add your bills"
        options={METHODS}
        value={value}
        onChange={setValue}
        layout={layout}
        hideIndicator={hideIndicator}
      />
    </div>
  );
}

const meta = {
  title: "Components/RadioCard",
  component: Demo,
  args: { initial: "email" },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selected: Story = {};
export const NoneSelected: Story = { args: { initial: null } };
export const OtherSelected: Story = { args: { initial: "csv" } };
export const Grid: Story = { args: { initial: "manual", layout: "grid" } };

/** Goal cards select with the border and tint alone. */
export const WithoutIndicator: Story = { args: { initial: "email", layout: "grid", hideIndicator: true } };
