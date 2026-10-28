// Column definitions for the "Due before payday" table, shared by stories and tests.
import { date, weekday } from "@mp/format";
import { Temporal } from "@js-temporal/polyfill";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { Amount } from "../amount/Amount";
import { Avatar } from "../avatar/Avatar";
import { StatusChip } from "../status-chip/StatusChip";
import type { BillRow } from "./bills-before-payday";
import { TwoLineCell } from "../table/Table";
import type { TableColumn } from "../table/Table";

const today = Temporal.PlainDate.from(fixture.today);

export const BILL_COLUMNS: ReadonlyArray<TableColumn<BillRow>> = [
  {
    key: "due",
    header: "Due",
    render: (r) => <TwoLineCell title={date(r.due, { relativeTo: today })} meta={weekday(r.due)} />,
  },
  {
    key: "bill",
    header: "Bill",
    rowHeader: true,
    render: (r) => <TwoLineCell title={r.name} meta={r.frequency} />,
  },
  {
    key: "owner",
    header: "Owner",
    render: (r) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--mp-space-2)" }}>
        <Avatar name={r.owner.name} role={r.owner.role} size={24} decorative />
        {r.owner.name}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (r) => <StatusChip variant={r.status.variant}>{r.status.label}</StatusChip>,
  },
  {
    key: "amount",
    header: "Amount",
    align: "end",
    render: (r) => <Amount cents={r.amountCents} mode={r.estimate ? "estimate" : "detail"} />,
  },
];
