import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { Stepper } from "./Stepper";

function Demo({ initialCents, maxCents }: { initialCents: number; maxCents?: number }) {
  const [value, setValue] = useState(initialCents);
  return <Stepper label="Monthly deposit" valueCents={value} onChange={setValue} maxCents={maxCents} />;
}

const tahoe = fixture.goals[1];

const meta = {
  title: "Components/Stepper",
  component: Demo,
  args: { initialCents: tahoe?.monthlyCents ?? 0 },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const AtMinimum: Story = { args: { initialCents: 0 } };
export const AtMaximum: Story = { args: { initialCents: 50000, maxCents: 50000 } };
