"use client";

import { Amount, Card, OwnerDot, StatusChip } from "@mp/ui";
import type { StatusChipVariant } from "@mp/ui";
import type { CalendarDayDto, CalendarEntryKind, CalendarResponse } from "../../../lib/api/planning-types";
import { selectedDayTitle } from "../../../lib/format/dates";
import { monthName } from "../../../lib/format/dates";
import type { Owners } from "../../../lib/owners";
import { money } from "@mp/format";
import { KIND_LABEL, entryNote } from "./notes";
import styles from "./calendar.module.css";

const CHIP: Record<CalendarEntryKind, StatusChipVariant> = {
  income: "income",
  bill: "info",
  estimate: "estimate",
  decision: "attention",
  planned: "info",
  goal_transfer: "info",
};

/** The selected day: one inner card per item (§4.2 side panel). */
export function DayPanel({
  day,
  owners,
  offsets,
}: {
  day: CalendarDayDto | null;
  owners: Owners;
  offsets: readonly number[];
}) {
  return (
    <Card>
      <div>
        <p className={styles.overline}>Selected day</p>
        <h2 className={styles.dayTitle} data-testid="selected-day">
          {day ? selectedDayTitle(day.date) : "No day selected"}
        </h2>
      </div>
      {day && day.entries.length === 0 && (
        <p className={styles.note}>
          Nothing scheduled. Pick another day, or add a bill, income or planned expense.
        </p>
      )}
      {day && day.entries.length > 0 && (
        <ul className={styles.items}>
          {day.entries.map((entry) => (
            <li key={`${entry.kind}-${entry.sourceId}`} className={styles.item}>
              <div className={styles.itemHead}>
                <h3 className={styles.itemName}>{entry.name}</h3>
                <Amount
                  cents={entry.amountCents}
                  mode={entry.isEstimate ? "estimate" : "signed"}
                  className={styles.itemAmount}
                />
              </div>
              <div className={styles.itemMeta}>
                <StatusChip variant={CHIP[entry.kind]}>{KIND_LABEL[entry.kind]}</StatusChip>
                <span className={styles.owner}>
                  <OwnerDot role={owners.role(entry.owner)} />
                  {owners.label(entry.owner)}
                </span>
              </div>
              <p className={styles.note}>{entryNote(entry, offsets)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "{Month} at a glance": income, bills, goals and planned, and what is left (§5.1). */
export function Glance({ calendar }: { calendar: CalendarResponse }) {
  const { summary } = calendar;
  // The household's month: `calendar` is the unfiltered response, whatever the owner filter shows.
  const entries = calendar.days.flatMap((d) => d.entries);
  const incomeCount = entries.filter((e) => e.kind === "income").length;
  const estimateNames = entries.filter((e) => e.isEstimate).map((e) => e.name);
  const estimates =
    summary.estimatesCount > 0
      ? `Includes ${summary.estimatesCount} ${summary.estimatesCount === 1 ? "estimate" : "estimates"} (${estimateNames.map((n) => n.toLowerCase()).join(", ")}). The total updates when you enter actual amounts.`
      : "The total updates when you enter actual amounts.";
  return (
    <Card title={`${monthName(calendar.month)} at a glance`}>
      <dl className={styles.glance}>
        <div className={styles.glanceRow}>
          <dt>{`Expected income · ${incomeCount} ${incomeCount === 1 ? "paycheck" : "paychecks"}`}</dt>
          <dd>{money(summary.incomeCents, { mode: "detail" })}</dd>
        </div>
        <div className={styles.glanceRow}>
          <dt>{`Bills · ${summary.billsCount}`}</dt>
          <dd>{money(-summary.billsCents, { mode: "detail" })}</dd>
        </div>
        <div className={styles.glanceRow}>
          <dt>Goals + planned expenses</dt>
          <dd>{money(-summary.goalsAndPlannedCents, { mode: "detail" })}</dd>
        </div>
        <div className={`${styles.glanceRow} ${styles.glanceTotal}`}>
          <dt>Left for everyday spending</dt>
          <dd>{money(summary.leftForEverydayCents, { mode: "detail" })}</dd>
        </div>
      </dl>
      <p className={styles.caption}>{estimates}</p>
    </Card>
  );
}
