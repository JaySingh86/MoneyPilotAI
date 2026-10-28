import type { Meta, StoryObj } from "@storybook/react-vite";
import { money } from "@mp/format";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { ProgressBar } from "./ProgressBar";

const [emergency, tahoe, gifts] = fixture.goals;
const caption = (g: { savedCents: number; targetCents: number } | undefined) =>
  g ? `${money(g.savedCents, { mode: "headline" })} of ${money(g.targetCents, { mode: "headline" })}` : "";

const meta = {
  title: "Components/ProgressBar",
  component: ProgressBar,
  decorators: [(Story) => <div style={{ maxWidth: "360px" }}>{Story()}</div>],
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// Percentages are the fixture's golden goal values (DESIGN_SPEC §5.1 Goals).
export const FirstGoal: Story = {
  args: { title: emergency?.name ?? "", percent: 64, tone: "brand", caption: caption(emergency) },
};
export const SecondGoal: Story = {
  args: { title: tahoe?.name ?? "", percent: 48, tone: "partnerA", caption: caption(tahoe) },
};
export const ThirdGoal: Story = {
  args: { title: gifts?.name ?? "", percent: 53, tone: "partnerB", caption: caption(gifts) },
};
export const Empty: Story = { args: { title: "New goal", percent: 0 } };
export const Complete: Story = { args: { title: "Emergency fund", percent: 100 } };
