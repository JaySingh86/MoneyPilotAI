import type { Meta, StoryObj } from "@storybook/react-vite";
import { money } from "@mp/format";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { KpiTile } from "./KpiTile";

const { expected } = fixture;

const meta = {
  title: "Components/KpiTile",
  component: KpiTile,
  decorators: [(Story) => <div style={{ maxWidth: "320px" }}>{Story()}</div>],
} satisfies Meta<typeof KpiTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BillsWithOwnerSplit: Story = {
  args: {
    label: "Bills before payday",
    value: { cents: expected.billsBeforePayday.totalCents, mode: "detail" },
    caption: `${expected.billsBeforePayday.count} bills`,
    split: [
      { role: "partnerA", name: "Sam", cents: expected.billsBeforePayday.byOwner["m-sam"] },
      { role: "partnerB", name: "Jordan", cents: expected.billsBeforePayday.byOwner["m-jordan"] },
    ],
  },
};

export const Income: Story = {
  args: {
    label: "Income per month on average",
    value: { cents: expected.billsPage.monthlyIncomeAverageCents, rounding: "nearest" },
    tone: "income",
    caption: "Biweekly pay × 26 ÷ 12",
  },
};

export const Attention: Story = {
  args: {
    label: "Price increases",
    value: { text: `${money(expected.renewals.priceIncreaseYearlyCents, { mode: "chip" })} / yr` },
    tone: "attention",
    caption: "Renters insurance",
  },
};

export const Brand: Story = {
  args: {
    label: "Could save",
    value: { cents: expected.renewals.couldSaveYearlyCents, mode: "detail" },
    tone: "brand",
    caption: "Items you marked as possibly unused",
  },
};

export const IncomeWithFootnote: Story = {
  args: {
    label: "Income expected",
    value: { cents: 290000, mode: "detail" },
    caption: "Fri, Oct 30 · Jordan’s paycheck",
    footnote: "Next: Sam’s paycheck $3,150 on Nov 6, then $550 to goals",
  },
};

export const Info: Story = {
  args: {
    label: "Estimates to confirm",
    value: { text: String(expected.billsPage.estimatesToConfirm) },
    tone: "info",
    caption: "Electricity and credit card",
  },
};

export const Mobile: Story = {
  args: {
    label: "Left over",
    value: { cents: expected.november.leftForEverydayCents, mode: "detail" },
    density: "mobile",
  },
};
