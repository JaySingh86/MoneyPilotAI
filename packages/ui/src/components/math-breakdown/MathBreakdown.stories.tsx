import type { Meta, StoryObj } from "@storybook/react-vite";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { MathBreakdown } from "./MathBreakdown";

const { expected } = fixture;
const shortfall = fixture.scenarios.shortfall.expected;
const cushion = fixture.household.cushionCents;

const meta = {
  title: "Components/MathBreakdown",
  component: MathBreakdown,
  decorators: [(Story) => <div style={{ maxWidth: "360px" }}>{Story()}</div>],
} satisfies Meta<typeof MathBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SafeToSpend: Story = {
  args: {
    rows: [
      { label: "Lowest projected balance, Nov 5", cents: expected.lowest.balanceCents, mode: "headline" },
      { label: "Cushion", cents: -cushion, mode: "headline" },
      { label: "Safe to spend", cents: expected.safeToSpendCents, mode: "headline", kind: "total" },
    ],
  },
};

export const TahoeGap: Story = {
  args: {
    rows: [
      { label: "Projected by Mar 1", cents: expected.tahoeGoal.projectedByTargetCents },
      { label: "Target", cents: 240000 },
      { label: "Behind", cents: expected.tahoeGoal.gapCents, kind: "gap" },
      { label: "Suggested each month", cents: expected.tahoeGoal.suggestedMonthlyCents, kind: "total" },
    ],
  },
};

export const Shortfall: Story = {
  args: {
    rows: [
      { label: "Lowest projected balance, Nov 5", cents: shortfall.lowest.balanceCents, mode: "headline" },
      { label: "Cushion", cents: -cushion, mode: "headline" },
      { label: "Short", cents: shortfall.safeToSpendCents, mode: "headline", kind: "gap" },
    ],
  },
};
