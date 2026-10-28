import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "../card/Card";
import { RunwayChart, RunwayMini } from "./RunwayChart";
import { fixtureCushionCents, fixtureToday, normalRunway, shortfallRunway } from "../testing/fixture-runway";

const meta = {
  title: "Components/RunwayChart",
  component: RunwayChart,
  args: {
    days: normalRunway.days,
    lowestDate: normalRunway.lowestDate,
    cushionCents: fixtureCushionCents,
    today: fixtureToday,
  },
  decorators: [(Story) => <div style={{ maxWidth: "760px" }}>{Story()}</div>],
} satisfies Meta<typeof RunwayChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Overview: fixture runway Oct 27 → Nov 6, lowest $1,507 on Nov 5. */
export const Normal: Story = {};

/** Shortfall scenario: negative bars hang below a solid $0 axis (lowest −$293 on Nov 5). */
export const Shortfall: Story = {
  args: { days: shortfallRunway.days, lowestDate: shortfallRunway.lowestDate },
};

export const InCard: Story = {
  render: (args) => (
    <Card
      title="Cash runway to payday"
      subtitle="Projected balance after each scheduled bill and paycheck. Day-to-day spending not included."
    >
      <RunwayChart {...args} />
    </Card>
  ),
};

/** Below 620 px the chart scrolls sideways inside its card. */
export const Narrow: Story = {
  decorators: [(Story) => <div style={{ maxWidth: "360px" }}>{Story()}</div>],
};

export const MiniOnHero: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gap: "var(--mp-space-4)",
        maxWidth: "340px",
        padding: "var(--mp-space-5)",
        background: "var(--mp-brand-strong)",
        borderRadius: "var(--mp-radius-4xl)",
      }}
    >
      <RunwayMini days={normalRunway.days} lowestDate={normalRunway.lowestDate} />
      <RunwayMini days={shortfallRunway.days} lowestDate={shortfallRunway.lowestDate} />
    </div>
  ),
};
