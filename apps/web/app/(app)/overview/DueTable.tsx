"use client";

import { estimateRange, money } from "@mp/format";
import { Amount, Card, EmptyState, SegmentedControl, StatusChip, Table, TwoLineCell } from "@mp/ui";
import type { TableColumn } from "@mp/ui";
import { useMemo, useState } from "react";
import type { DueRowDto, PlanResponse } from "../../../lib/api/planning-types";
import { OwnerCell } from "../../../lib/components/OwnerCell";
import { shortDate, weekdayName } from "../../../lib/format/dates";
import type { Owners } from "../../../lib/owners";

type OwnerFilter = "all" | string;

function Status({ row }: { row: DueRowDto }) {
  if (row.flags.includes("not_usual_month"))
    return <StatusChip variant="attention">Not usual month</StatusChip>;
  if (row.flags.includes("price_up") && row.priceUpCents !== null) {
    return (
      <StatusChip variant="attention">{`Price up ${money(row.priceUpCents, { mode: "headline", rounding: "nearest" })}`}</StatusChip>
    );
  }
  if (row.isEstimate && row.estimateRangeCents !== null) {
    return <StatusChip variant="estimate">{`Estimate ${estimateRange(row.estimateRangeCents)}`}</StatusChip>;
  }
  if (row.kind === "planned_expense") return <StatusChip variant="info">Planned</StatusChip>;
  return <StatusChip variant="ok">Reminder set</StatusChip>;
}

/** Rule 13: a partner's filter includes their own items plus items owned by Both or Split. */
function visible(row: DueRowDto, filter: OwnerFilter, owners: Owners): boolean {
  return filter === "all" || row.owner === filter || owners.member(row.owner) === null;
}

export function DueTable({ plan, owners }: { plan: PlanResponse; owners: Owners }) {
  const [filter, setFilter] = useState<OwnerFilter>("all");
  const rows = useMemo(
    () => plan.dueBeforePayday.filter((r) => visible(r, filter, owners)),
    [plan.dueBeforePayday, filter, owners],
  );
  const total = rows.reduce((sum, r) => sum + r.amountCents, 0);

  const columns: ReadonlyArray<TableColumn<DueRowDto>> = [
    {
      key: "due",
      header: "Due",
      render: (r) => <TwoLineCell title={shortDate(r.dueOn, plan.asOf)} meta={weekdayName(r.dueOn)} />,
    },
    {
      key: "bill",
      header: "Bill",
      rowHeader: true,
      render: (r) => <TwoLineCell title={r.name} meta={r.frequencyLabel} />,
    },
    { key: "owner", header: "Owner", render: (r) => <OwnerCell ownerId={r.owner} owners={owners} /> },
    { key: "status", header: "Status", render: (r) => <Status row={r} /> },
    {
      key: "amount",
      header: "Amount",
      align: "end",
      render: (r) => <Amount cents={r.amountCents} mode={r.isEstimate ? "estimate" : "detail"} />,
    },
  ];

  return (
    <Card
      title="Due before payday"
      subtitle="Every bill has an owner and a reminder. MoneyPilot never pays bills for you."
      actions={
        <SegmentedControl
          label="Filter by owner"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Both" },
            ...owners.members.map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
      }
    >
      <Table
        caption="Bills due before payday"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        total={{ label: `Total due before ${shortDate(plan.window.to, plan.asOf)}`, cents: total }}
        empty={
          <EmptyState>Nothing is due before payday. New bills will appear here as they are added.</EmptyState>
        }
      />
    </Card>
  );
}
