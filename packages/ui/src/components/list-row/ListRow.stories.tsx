import type { Meta, StoryObj } from "@storybook/react-vite";
import { estimateRange } from "@mp/format";
import { StatusChip } from "../status-chip/StatusChip";
import { BILLS_BEFORE_PAYDAY } from "../testing/bills-before-payday";
import { ListRow, ListRows } from "./ListRow";

function BeforePayday({ count }: { count: number }) {
  return (
    <div style={{ maxWidth: "390px", background: "var(--mp-bg-surface)", padding: "0 var(--mp-space-4)" }}>
      <ListRows label="Before payday">
        {BILLS_BEFORE_PAYDAY.slice(0, count).map((bill) => (
          <ListRow
            key={bill.id}
            href={`/bills/${bill.id}`}
            date={bill.due}
            title={bill.name}
            meta={bill.owner.name}
            amountCents={bill.amountCents}
            amountMode={bill.estimate ? "estimate" : "detail"}
            trailing={
              bill.estimate ? (
                <StatusChip variant="estimate">{estimateRange(3000, { label: true })}</StatusChip>
              ) : undefined
            }
          />
        ))}
      </ListRows>
    </div>
  );
}

const meta = {
  title: "Components/ListRow",
  component: BeforePayday,
  args: { count: 4 },
} satisfies Meta<typeof BeforePayday>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NextFour: Story = {};
export const WithEstimate: Story = { args: { count: 6 } };

export const WithoutDate: Story = {
  render: () => (
    <div style={{ maxWidth: "390px", background: "var(--mp-bg-surface)", padding: "0 var(--mp-space-4)" }}>
      <ListRows label="Monthly subscriptions">
        <ListRow href="/renewals/news" title="News" meta="Monthly · Jordan" amountCents={800} />
        <ListRow href="/renewals/cloud" title="Cloud storage" meta="Monthly · Sam" amountCents={299} />
      </ListRows>
    </div>
  ),
};
