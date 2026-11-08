"use client";

import { Temporal } from "@js-temporal/polyfill";
import {
  Amount,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FilterPills,
  KpiTile,
  Loading,
  SegmentedControl,
  Skeleton,
  StatusChip,
  Table,
  TwoLineCell,
} from "@mp/ui";
import type { TableColumn } from "@mp/ui";
import { Plus, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { usePlan, useSummary } from "../../../lib/api/hooks";
import { OwnerCell } from "../../../lib/components/OwnerCell";
import { PageHeader } from "../../../lib/components/PageHeader";
import { shortDate, shortDateWithYear } from "../../../lib/format/dates";
import { nameList, relativeFrom } from "../../../lib/lists/dates";
import { useBillsItems, useOccurrences, useRenewals } from "../../../lib/lists/hooks";
import { cadenceWords, categoryLabel, scheduleLabel } from "../../../lib/lists/labels";
import lists from "../../../lib/lists/lists.module.css";
import { NameButton } from "../../../lib/lists/NameButton";
import { useOwners } from "../../../lib/owners";
import { BillDetail } from "./BillDetail";
import { TYPE_TESTS, buildRows, ownerVisible } from "./derive";
import type { BillRow, TypeFilter } from "./derive";

/** The longest range the occurrences endpoint takes is 420 days. */
const LOOKAHEAD_DAYS = 400;

function Skeletons() {
  return (
    <Loading label="Loading bills">
      <Skeleton shape="block" height="120px" />
      <Skeleton shape="block" height="420px" />
    </Loading>
  );
}

export function BillsScreen() {
  const router = useRouter();
  const plan = usePlan();
  const summary = useSummary();
  const items = useBillsItems();
  const owners = useOwners();
  const asOf = plan.data?.asOf ?? null;
  const to = asOf ? Temporal.PlainDate.from(asOf).add({ days: LOOKAHEAD_DAYS }).toString() : null;
  const occurrences = useOccurrences(asOf, to);
  const renewals = useRenewals();
  const [type, setType] = useState<TypeFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [picked, setPicked] = useState<string | null>(null);
  const defaultId = useRef<string | null>(null);

  const rows = useMemo(
    () =>
      plan.data && items.data && occurrences.data
        ? buildRows(
            items.data.items,
            occurrences.data,
            plan.data,
            summary.data?.household.primaryIncomeItemId ?? null,
          )
        : [],
    [plan.data, items.data, occurrences.data, summary.data],
  );

  const header = (subtitle?: string) => (
    <PageHeader
      overline="Everything that repeats"
      title="Bills & recurring"
      subtitle={subtitle}
      actions={
        <>
          <Button variant="secondary" inHeader icon={Upload} onClick={() => router.push("/imports")}>
            Import CSV
          </Button>
          <Button icon={Plus} disabled title="Adding by hand arrives with the item forms (Q-164)">
            Add bill or income
          </Button>
        </>
      }
    />
  );

  if (plan.isError || items.isError || occurrences.isError) {
    return (
      <>
        {header()}
        <ErrorBanner
          title="We couldn’t load your bills."
          onRetry={() => {
            void plan.refetch();
            void items.refetch();
            void occurrences.refetch();
          }}
        >
          Nothing was changed. Your plan on the Overview is unaffected.
        </ErrorBanner>
      </>
    );
  }
  if (!plan.data || !items.data || !occurrences.data || !owners) {
    return (
      <>
        {header()}
        <Skeletons />
      </>
    );
  }

  const { averages } = items.data;
  const all = items.data.items;
  const bills = all.filter((i) => i.direction === "outflow").length;
  const paychecks = all.length - bills;
  const estimateNames = all.filter(TYPE_TESTS.estimates).map((i) => i.name);
  const incomeCaption = all
    .filter((i) => i.direction === "inflow")
    .map((i) => `${i.ownerUserId ? owners.label(i.ownerUserId) : "Both"} ${cadenceWords(i.schedule)}`)
    .join(", ");

  const shown = rows.filter((r) => TYPE_TESTS[type](r.item) && ownerVisible(r.item, ownerFilter));
  const defaultRow =
    rows.find((r) => r.item.amountType !== "fixed" && r.item.direction === "outflow") ?? rows[0];
  // The default stays put after a bill is marked paid and moves down the list.
  if (defaultId.current === null && defaultRow) defaultId.current = defaultRow.item.id;
  const selected = rows.find((r) => r.item.id === (picked ?? defaultId.current)) ?? defaultRow;
  const renewalByItem = new Map(
    (renewals.data ?? []).flatMap((r) => (r.itemId ? [[r.itemId, r] as const] : [])),
  );

  const columns: ReadonlyArray<TableColumn<BillRow>> = [
    {
      key: "name",
      header: "Name",
      rowHeader: true,
      render: (r) => (
        <TwoLineCell
          title={
            <NameButton pressed={r.item.id === selected?.item.id} onClick={() => setPicked(r.item.id)}>
              {r.item.name}
            </NameButton>
          }
          meta={
            r.isPrimaryIncome ? `${categoryLabel(r.item.category)} · primary` : categoryLabel(r.item.category)
          }
        />
      ),
    },
    {
      key: "schedule",
      header: "Schedule",
      render: (r) => scheduleLabel(r.item.schedule, r.item.amountType),
    },
    {
      key: "next",
      header: "Next",
      render: (r) =>
        r.next ? (
          <span className={lists.noWrap}>
            <TwoLineCell
              title={shortDate(r.next, plan.data.asOf)}
              meta={relativeFrom(plan.data.asOf, r.next)}
            />
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "owner",
      header: "Owner",
      render: (r) => (
        <OwnerCell
          ownerId={r.item.ownerUserId ?? r.item.ownerType}
          owners={owners}
          size={24}
          showName={false}
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusChip variant={r.status.variant}>{r.status.text}</StatusChip>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "end",
      render: (r) =>
        r.item.amountCents === null ? (
          "—"
        ) : (
          <Amount
            cents={r.item.amountCents}
            mode={
              r.item.direction === "inflow" ? "signed" : r.item.amountType === "fixed" ? "detail" : "estimate"
            }
          />
        ),
    },
  ];

  return (
    <>
      {header(
        `${bills} bills and ${paychecks} ${paychecks === 1 ? "paycheck" : "paychecks"}. Each one has an owner, a schedule and reminders.`,
      )}

      {averages && (
        <div className={lists.kpiRow}>
          <KpiTile
            label="Bills per month, on average"
            value={{ cents: averages.monthlyBillsAverageCents, mode: "detail" }}
            caption="Yearly and quarterly bills spread by month"
          />
          <KpiTile
            label="Income per month, on average"
            value={{ cents: averages.monthlyIncomeAverageCents, mode: "detail" }}
            tone="income"
            caption={incomeCaption}
          />
          <KpiTile
            label="Left after bills"
            value={{ cents: averages.leftAfterBillsCents, mode: "detail" }}
            caption="Before goals and everyday spending"
          />
          <KpiTile
            label="Estimates to confirm"
            value={{ text: String(averages.estimatesToConfirm) }}
            tone="info"
            caption={nameList(estimateNames)}
          />
        </div>
      )}

      <div className={lists.layout}>
        <div className={`${lists.main} ${lists.mainWide}`}>
          <Card>
            <div className={lists.cardBody}>
              <div className={lists.toolbar}>
                <FilterPills
                  label="Filter by type"
                  value={type}
                  onChange={setType}
                  options={[
                    { value: "all", label: "All", count: all.length },
                    { value: "bills", label: "Bills", count: all.filter(TYPE_TESTS.bills).length },
                    { value: "income", label: "Income", count: all.filter(TYPE_TESTS.income).length },
                    {
                      value: "subscriptions",
                      label: "Subscriptions",
                      count: all.filter(TYPE_TESTS.subscriptions).length,
                    },
                    {
                      value: "estimates",
                      label: "Estimates",
                      count: all.filter(TYPE_TESTS.estimates).length,
                    },
                  ]}
                />
                <SegmentedControl
                  label="Filter by owner"
                  value={ownerFilter}
                  onChange={setOwnerFilter}
                  options={[
                    { value: "all", label: "Both" },
                    ...owners.members.map((m) => ({ value: m.id, label: m.name })),
                  ]}
                />
              </div>
              <Table
                caption="Bills and income that repeat"
                columns={columns}
                rows={shown}
                rowKey={(r) => r.item.id}
                selectedKey={selected?.item.id}
                empty={
                  <EmptyState>
                    {all.length === 0
                      ? "No bills yet. Import a bank CSV or connect your email and they will appear here."
                      : "Nothing matches these filters."}
                  </EmptyState>
                }
              />
            </div>
          </Card>
        </div>
        {selected && (
          <BillDetail
            key={selected.item.id}
            row={selected}
            plan={plan.data}
            owners={owners}
            renewal={renewalByItem.get(selected.item.id)}
          />
        )}
      </div>

      <p className={lists.footer}>
        {plan.data.dataSource.isSample ? "Sample data · " : ""}
        {`Updated from ${plan.data.dataSource.label} ${shortDateWithYear(plan.data.dataSource.updatedOn)} · All amounts in USD`}
      </p>
    </>
  );
}
