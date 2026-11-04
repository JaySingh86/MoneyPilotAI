"use client";

import { Temporal } from "@js-temporal/polyfill";
import {
  Amount,
  AttentionCard,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FilterPills,
  KpiTile,
  Loading,
  Skeleton,
  StatusChip,
  Table,
  TwoLineCell,
} from "@mp/ui";
import type { TableColumn } from "@mp/ui";
import { money } from "@mp/format";
import { Mail, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePlan } from "../../../lib/api/hooks";
import type { Plan } from "../../../lib/api/planning-types";
import { OwnerCell } from "../../../lib/components/OwnerCell";
import { PageHeader } from "../../../lib/components/PageHeader";
import { shortDate } from "../../../lib/format/dates";
import { daysFrom, nameList, relativeFrom } from "../../../lib/lists/dates";
import { useRenewals, useRenewalsSummary } from "../../../lib/lists/hooks";
import type { RenewalRow, RenewalsSummary } from "../../../lib/lists/hooks";
import { sourceLabel } from "../../../lib/lists/labels";
import lists from "../../../lib/lists/lists.module.css";
import { NameButton } from "../../../lib/lists/NameButton";
import { useOwners } from "../../../lib/owners";
import type { Owners } from "../../../lib/owners";
import {
  CATEGORY_LABEL,
  RADAR_DAYS,
  actByText,
  autoRenewsText,
  compactMoney,
  costFrequency,
  dollars,
  frequencyWords,
  needsDecision,
  noteFor,
  radarDate,
  radarRows,
  statusOf,
} from "./derive";
import styles from "./renewals.module.css";

type Category = "all" | RenewalRow["category"];

const ownerKey = (r: RenewalRow): string => r.owner;

function cardDate(r: RenewalRow, today: string, short: (iso: string) => string): string {
  if (r.actByKind === "decision" && r.actBy) return `${short(r.actBy)} · decide`;
  if (r.actByKind === "cancel" && r.actBy) return `${short(r.renewsOn)} · cancel by ${short(r.actBy)}`;
  if (r.priceUp) return `${short(r.renewsOn)} · up ${dollars(r.annualIncreaseCents)}`;
  return `${short(r.renewsOn)} · ${relativeFrom(today, r.renewsOn)}`;
}

function Radar({
  rows,
  today,
  plan,
  owners,
}: {
  rows: readonly RenewalRow[];
  today: string;
  plan: Plan;
  owners: Owners;
}) {
  const short = (iso: string) => shortDate(iso, today);
  const end = Temporal.PlainDate.from(today).add({ days: RADAR_DAYS }).toString();
  const place = (iso: string) => `${Math.min(100, Math.max(0, (daysFrom(today, iso) / RADAR_DAYS) * 100))}%`;
  // Month starts inside the window label the track.
  const ticks: string[] = [];
  for (
    let d = Temporal.PlainDate.from(today).add({ months: 1 }).with({ day: 1 });
    Temporal.PlainDate.compare(d, Temporal.PlainDate.from(end)) < 0;
    d = d.add({ months: 1 })
  )
    ticks.push(d.toString());
  return (
    <Card
      title="Renewal radar · next 90 days"
      subtitle="Yearly and 6-month renewals that are easy to forget. Owners get reminders 30 and 7 days before."
    >
      {rows.length === 0 ? (
        <EmptyState>
          Nothing big renews in the next 90 days. Yearly and 6-month renewals will appear here.
        </EmptyState>
      ) : (
        <div className={styles.radar}>
          <div aria-hidden="true" className={styles.track}>
            <span className={styles.line} />
            {rows.map((r) => (
              <span
                key={r.id}
                className={`${styles.dot} ${needsDecision(plan, r) ? styles.dotAttention : ""}`}
                style={{ left: place(radarDate(r)) }}
              />
            ))}
            <span className={styles.tick} style={{ left: 0 }}>
              Today
            </span>
            {ticks.map((t) => (
              <span key={t} className={styles.tick} style={{ left: place(t) }}>
                {short(t)}
              </span>
            ))}
            <span className={styles.tick} style={{ right: 0 }}>
              {short(end)}
            </span>
          </div>
          <ul className={styles.cards}>
            {rows.map((r) => {
              const meta = `${compactMoney(r.amountCents)} · ${frequencyWords(r.every)} · ${owners.label(ownerKey(r))}`;
              return (
                <li key={r.id}>
                  {needsDecision(plan, r) ? (
                    <AttentionCard label={cardDate(r, today, short)} title={r.name}>
                      <span className={styles.meta}>{meta}</span>
                    </AttentionCard>
                  ) : (
                    <article className={styles.plainCard}>
                      <p className={styles.plainDate}>{cardDate(r, today, short)}</p>
                      <h3 className={styles.plainTitle}>{r.name}</h3>
                      <p className={styles.meta}>{meta}</p>
                    </article>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Detail({ row, today, owners }: { row: RenewalRow; today: string; owners: Owners }) {
  const short = (iso: string) => shortDate(iso, today);
  return (
    <aside className={lists.aside} aria-label="Selected renewal">
      <div>
        <p className={lists.overline}>{CATEGORY_LABEL[row.category]}</p>
        <h2 className={lists.asideTitle}>{row.name}</h2>
      </div>
      <div className={lists.priceRow}>
        <span className={lists.price}>{money(row.amountCents, { mode: "detail" })}</span>
        <span>{costFrequency(row.every)}</span>
      </div>
      <dl className={lists.dl}>
        <dt>Next renewal</dt>
        <dd className={lists.strong}>{`${short(row.renewsOn)} · ${relativeFrom(today, row.renewsOn)}`}</dd>
        <dt>Act by</dt>
        <dd className={lists.strong}>{actByText(row, today, short)}</dd>
        <dt>Owner</dt>
        <dd>{owners.label(ownerKey(row))}</dd>
        <dt>Auto-renews</dt>
        <dd>{autoRenewsText(row.autoRenews)}</dd>
        <dt>Cost per year</dt>
        <dd>{money(row.annualCents, { mode: "detail" })}</dd>
        <dt>Found in</dt>
        <dd>{sourceLabel(row.sources)}</dd>
      </dl>
      <p className={lists.note}>{noteFor(row)}</p>
      <div className={lists.actions}>
        <Button disabled title="Marking a renewal reviewed needs its API (Q-165)">
          Mark as reviewed
        </Button>
        <Button variant="secondary" disabled title="Reminder settings arrive with notifications (WP-15)">
          Edit reminders
        </Button>
      </div>
      <Link href="/imports" className={lists.link}>
        See what we read from email
      </Link>
    </aside>
  );
}

function Loaded({
  rows,
  summary,
  plan,
  owners,
}: {
  rows: readonly RenewalRow[];
  summary: RenewalsSummary;
  plan: Plan;
  owners: Owners;
}) {
  const today = plan.asOf;
  const short = (iso: string) => shortDate(iso, today);
  const [category, setCategory] = useState<Category>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = rows.filter((r) => category === "all" || r.category === category);
  const radar = radarRows(rows, summary.next90Days.ids, today);
  const defaultRow = rows.find((r) => r.big && r.priceUp) ?? rows[0];
  const selected = rows.find((r) => r.id === picked) ?? defaultRow;
  const counts = summary.countsByCategory;
  const priceNames = rows.filter((r) => r.priceUp).map((r) => r.name);
  const unused = rows.filter((r) => r.markedPossiblyUnused).length;
  const decisions = summary.next90Days.planDecisions;

  const columns: ReadonlyArray<TableColumn<RenewalRow>> = [
    {
      key: "name",
      header: "Name",
      rowHeader: true,
      render: (r) => (
        <TwoLineCell
          title={
            <NameButton pressed={r.id === selected?.id} onClick={() => setPicked(r.id)}>
              {r.name}
            </NameButton>
          }
          meta={CATEGORY_LABEL[r.category]}
        />
      ),
    },
    {
      key: "cost",
      header: "Cost",
      render: (r) => <TwoLineCell title={<Amount cents={r.amountCents} />} meta={costFrequency(r.every)} />,
    },
    {
      key: "renews",
      header: "Next renewal",
      render: (r) => <TwoLineCell title={short(r.renewsOn)} meta={relativeFrom(today, r.renewsOn)} />,
    },
    {
      key: "owner",
      header: "Owner",
      render: (r) => <OwnerCell ownerId={ownerKey(r)} owners={owners} size={24} showName={false} />,
    },
    { key: "found", header: "Found in", render: (r) => sourceLabel(r.sources) },
    {
      key: "status",
      header: "Status",
      render: (r) => {
        const s = statusOf(plan, r, short);
        return <StatusChip variant={s.variant}>{s.text}</StatusChip>;
      },
    },
  ];

  return (
    <>
      <div className={lists.kpiRow}>
        <KpiTile
          className={lists.heroTile}
          label="Yearly cost"
          value={{ cents: summary.yearlyCents, mode: "detail" }}
          caption={`${summary.count} items · about ${dollars(summary.monthlyAverageCents)} a month`}
        />
        <KpiTile
          label="Big renewals, next 90 days"
          value={{ cents: summary.next90Days.cents, mode: "detail" }}
          caption={`${summary.next90Days.count} payments + ${decisions} plan ${decisions === 1 ? "decision" : "decisions"}`}
        />
        <KpiTile
          label="Price increases"
          value={{ text: `+${dollars(summary.priceIncreaseYearlyCents)} / yr` }}
          tone="attention"
          caption={nameList(priceNames)}
        />
        <KpiTile
          label="Could save"
          value={{ text: `${money(summary.couldSaveYearlyCents, { mode: "detail" })} / yr` }}
          tone="brand"
          caption={`If you drop the ${unused} you flagged as unused`}
        />
      </div>

      <Radar rows={radar} today={today} plan={plan} owners={owners} />

      <div className={lists.layout}>
        <div className={lists.main}>
          <Card>
            <div className={lists.cardBody}>
              <FilterPills
                label="Filter by type"
                value={category}
                onChange={setCategory}
                options={[
                  { value: "all", label: "All", count: summary.count },
                  { value: "insurance", label: "Insurance", count: counts.insurance },
                  { value: "subscription", label: "Subscriptions", count: counts.subscription },
                  { value: "membership", label: "Memberships", count: counts.membership },
                  { value: "vehicle_home", label: "Vehicle & home", count: counts.vehicle_home },
                ]}
              />
              <Table
                caption="Everything that renews"
                columns={columns}
                rows={shown}
                rowKey={(r) => r.id}
                selectedKey={selected?.id}
                empty={
                  <EmptyState>
                    Nothing in this group yet. New renewals will appear here as they are found.
                  </EmptyState>
                }
              />
            </div>
          </Card>
        </div>
        {selected && <Detail key={selected.id} row={selected} today={today} owners={owners} />}
      </div>
    </>
  );
}

export function RenewalsScreen() {
  const router = useRouter();
  const plan = usePlan();
  const renewals = useRenewals();
  const summary = useRenewalsSummary();
  const owners = useOwners();

  const header = (
    <PageHeader
      overline="Everything that renews"
      title="Subscriptions & renewals"
      subtitle="Insurance, subscriptions, memberships and registrations, found in your email and bank CSV."
      actions={
        <>
          <Button variant="secondary" inHeader icon={Mail} onClick={() => router.push("/imports")}>
            Scan email now
          </Button>
          <Button icon={Plus} disabled title="Adding by hand arrives with the item forms (Q-164)">
            Add renewal
          </Button>
        </>
      }
    />
  );

  if (renewals.isError || summary.isError || plan.isError) {
    return (
      <>
        {header}
        <ErrorBanner
          title="We couldn’t load your renewals."
          onRetry={() => {
            void renewals.refetch();
            void summary.refetch();
            void plan.refetch();
          }}
        >
          Nothing was changed. Your plan on the Overview is unaffected.
        </ErrorBanner>
      </>
    );
  }
  if (!renewals.data || !summary.data || !plan.data || !owners) {
    return (
      <>
        {header}
        <Loading label="Loading renewals">
          <Skeleton shape="block" height="120px" />
          <Skeleton shape="block" height="420px" />
        </Loading>
      </>
    );
  }
  return (
    <>
      {header}
      <Loaded rows={renewals.data} summary={summary.data} plan={plan.data} owners={owners} />
      <p className={lists.footer}>
        {plan.data.dataSource.isSample ? "Sample data · Company names are fictional · " : ""}All amounts in
        USD
      </p>
    </>
  );
}
