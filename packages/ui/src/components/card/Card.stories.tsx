import type { Meta, StoryObj } from "@storybook/react-vite";
import { money } from "@mp/format";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { Button } from "../button/Button";
import { RunwayMini } from "../runway-chart/RunwayChart";
import { normalRunway, shortfallRunway } from "../testing/fixture-runway";
import { StatusChip } from "../status-chip/StatusChip";
import { AttentionCard, Card, HeroCard } from "./Card";

const { expected } = fixture;
const shortfall = fixture.scenarios.shortfall.expected;
const cushion = fixture.household.cushionCents;

const meta = {
  title: "Components/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {
  args: {
    title: "Goals & planned expenses",
    subtitle: "Transfers are reminders. MoneyPilot never moves money.",
    children: <p style={{ margin: 0 }}>Card body</p>,
  },
};

export const StandardWithActions: Story = {
  args: {
    title: "Decide this week",
    actions: <StatusChip variant="attention">3 to decide</StatusChip>,
    children: <p style={{ margin: 0 }}>Suggestions go here.</p>,
  },
};

export const StandardMobile: Story = {
  args: { title: "Before payday", density: "mobile", children: <p style={{ margin: 0 }}>Rows</p> },
};

function Breakdown({ lowest, total }: { lowest: number; total: number }) {
  return (
    <>
      <span>
        Lowest projected balance <strong>{money(lowest, { mode: "headline" })}</strong> on Nov 5
      </span>
      <span aria-hidden="true">−</span>
      <span>
        Cushion <strong>{money(cushion, { mode: "headline" })}</strong>
      </span>
      <span aria-hidden="true">=</span>
      <strong>{money(total, { mode: "headline" })}</strong>
      <a href="#math">See the math</a>
    </>
  );
}

export const Hero: Story = {
  render: () => (
    <HeroCard
      label="Safe to spend until Fri, Nov 6"
      amountCents={expected.safeToSpendCents}
      status={`${expected.perDayDisplay} for ${expected.planningWindow.daysToPayday} days`}
      breakdown={<Breakdown lowest={expected.lowest.balanceCents} total={expected.safeToSpendCents} />}
    />
  ),
};

export const HeroShortfall: Story = {
  render: () => (
    <HeroCard
      variant="shortfall"
      paydayLabel="Fri, Nov 6"
      amountCents={shortfall.safeToSpendCents}
      caption="Below your cushion from Nov 3, below $0 on Nov 4–5"
      breakdown={<Breakdown lowest={shortfall.lowest.balanceCents} total={shortfall.safeToSpendCents} />}
    />
  ),
};

export const HeroMobile: Story = {
  render: () => (
    <div style={{ maxWidth: "390px" }}>
      <HeroCard
        density="mobile"
        label="Safe to spend until Fri, Nov 6"
        amountCents={expected.safeToSpendCents}
        status={`${expected.perDayDisplay} for ${expected.planningWindow.daysToPayday} days`}
      >
        <RunwayMini days={normalRunway.days} lowestDate={normalRunway.lowestDate} />
      </HeroCard>
    </div>
  ),
};

export const HeroMobileShortfall: Story = {
  render: () => (
    <div style={{ maxWidth: "390px" }}>
      <HeroCard
        density="mobile"
        variant="shortfall"
        paydayLabel="Fri, Nov 6"
        amountCents={shortfall.safeToSpendCents}
      >
        <RunwayMini days={shortfallRunway.days} lowestDate={shortfallRunway.lowestDate} />
      </HeroCard>
    </div>
  ),
};

export const Attention: Story = {
  render: () => (
    <AttentionCard
      label="Needs a decision · Jordan"
      title="Car insurance renews Nov 4"
      actions={
        <>
          <Button size="compact">Review</Button>
          <Button size="compact" variant="text">
            Later
          </Button>
        </>
      }
    >
      <p>
        {money(68400, { mode: "detail" })} is due the day before your lowest point. Paying on payday instead
        keeps more room. Only if your insurer allows it.
      </p>
    </AttentionCard>
  ),
};
