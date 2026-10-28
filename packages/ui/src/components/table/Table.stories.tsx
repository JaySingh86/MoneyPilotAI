import type { Meta, StoryObj } from "@storybook/react-vite";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { EmptyState } from "../states/States";
import { BILLS_BEFORE_PAYDAY } from "../testing/bills-before-payday";
import type { BillRow } from "../testing/bills-before-payday";
import { BILL_COLUMNS } from "../testing/bill-columns";
import { Table } from "./Table";

const meta = {
  title: "Components/Table",
  component: Table<BillRow>,
  args: {
    caption: "Due before payday",
    columns: BILL_COLUMNS,
    rows: BILLS_BEFORE_PAYDAY,
    rowKey: (r: BillRow) => r.id,
    total: { label: "Total due before Nov 6", cents: fixture.expected.billsBeforePayday.totalCents },
  },
} satisfies Meta<typeof Table<BillRow>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DueBeforePayday: Story = {};
export const SelectedRow: Story = { args: { selectedKey: "b-power" } };
export const Dense: Story = { args: { dense: true, total: undefined } };
export const VisibleCaption: Story = { args: { showCaption: true } };
export const Empty: Story = {
  args: {
    rows: [],
    total: undefined,
    empty: <EmptyState>Nothing is due before payday. New bills will appear here as they arrive.</EmptyState>,
  },
};
