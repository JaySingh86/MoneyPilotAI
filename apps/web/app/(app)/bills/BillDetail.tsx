"use client";

import { estimateRange, money } from "@mp/format";
import { Amount, Button, StatusBanner } from "@mp/ui";
import { Temporal } from "@js-temporal/polyfill";
import { useState } from "react";
import type { Plan } from "../../../lib/api/planning-types";
import { relativeFrom } from "../../../lib/lists/dates";
import { shortDate } from "../../../lib/format/dates";
import { categoryLabel, scheduleLabel, sourceLabel } from "../../../lib/lists/labels";
import { useItemHistory, useMarkOccurrence } from "../../../lib/lists/hooks";
import type { RenewalRow } from "../../../lib/lists/hooks";
import type { Owners } from "../../../lib/owners";
import lists from "../../../lib/lists/lists.module.css";
import { estimateRangeOf, remindersFor } from "./derive";
import type { BillRow } from "./derive";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const dollars = (cents: number) => money(cents, { mode: "headline", rounding: "nearest" });

/** "Aug $118": the month a past bill was for, and its amount. */
function historyChip(occurredOn: string, cents: number): string {
  const month = MONTHS[Temporal.PlainDate.from(occurredOn).month - 1];
  return `${month} ${dollars(cents)}`;
}

export function BillDetail({
  row,
  plan,
  owners,
  renewal,
}: {
  row: BillRow;
  plan: Plan;
  owners: Owners;
  renewal: RenewalRow | undefined;
}) {
  const { item } = row;
  const history = useItemHistory(item.id);
  const mark = useMarkOccurrence();
  const [marked, setMarked] = useState<{ id: string; name: string; status: "paid" | "received" } | null>(
    null,
  );
  const income = item.direction === "inflow";
  const estimated = item.direction === "outflow" && item.amountType !== "fixed";
  const range = estimateRangeOf(plan, item.id);
  const last = history.data?.[history.data.length - 1];
  const category = row.isPrimaryIncome
    ? `${categoryLabel(item.category)} · primary`
    : categoryLabel(item.category);
  const verb = income ? "received" : "paid";

  function markNow() {
    if (!row.occurrenceId) return;
    mark.mutate(
      { occurrence: { id: row.occurrenceId, version: 1 }, status: verb },
      { onSuccess: () => setMarked({ id: row.occurrenceId ?? "", name: item.name, status: verb }) },
    );
  }

  return (
    <aside className={lists.aside} aria-label="Selected bill">
      <div>
        <p className={lists.overline}>{category}</p>
        <h2 className={lists.asideTitle}>{item.name}</h2>
      </div>
      <div className={lists.priceRow}>
        {item.amountCents !== null && (
          <span className={`${lists.price} ${income ? lists.priceIncome : ""}`}>
            <Amount cents={item.amountCents} mode={income ? "signed" : estimated ? "estimate" : "detail"} />
          </span>
        )}
        <span>{scheduleLabel(item.schedule, item.amountType)}</span>
      </div>
      <dl className={lists.dl}>
        <dt>Next</dt>
        <dd className={lists.strong}>
          {row.next
            ? `${shortDate(row.next, plan.asOf)} · ${relativeFrom(plan.asOf, row.next)}`
            : "Nothing scheduled"}
        </dd>
        <dt>Owner</dt>
        <dd>{item.ownerUserId ? owners.label(item.ownerUserId) : owners.label(item.ownerType)}</dd>
        <dt>Reminders</dt>
        <dd>{remindersFor(item, renewal)}</dd>
        <dt>Found in</dt>
        <dd>{sourceLabel(renewal?.sources ?? [item.source])}</dd>
        <dt>Last time</dt>
        <dd>
          {last
            ? `${shortDate(last.occurredOn, plan.asOf)} · ${money(last.amountCents, { mode: "detail" })}`
            : "—"}
        </dd>
      </dl>
      {estimated && history.data && history.data.length > 0 && (
        <div className={lists.box}>
          <p className={lists.overline}>How the estimate works</p>
          <div className={lists.chips}>
            {history.data.map((h) => (
              <span key={h.id} className={lists.historyChip}>
                {historyChip(h.occurredOn, h.amountCents)}
              </span>
            ))}
            {item.amountCents !== null && (
              <span className={lists.historyChip}>
                {`Estimate ${money(item.amountCents, { mode: "estimate" })}${range !== null ? ` ${estimateRange(range)}` : ""}`}
              </span>
            )}
          </div>
          <p className={lists.muted}>
            Average of the last 3 bills, ± half the spread rounded up to $10. Replaced by the actual amount
            when the bill arrives.
          </p>
        </div>
      )}
      {(item.notes || row.isPrimaryIncome) && (
        <p className={lists.note}>
          {row.isPrimaryIncome
            ? "This is the household’s primary income, so safe to spend runs until this payday. Change it in Members & privacy."
            : item.notes}
        </p>
      )}
      {marked && (
        <StatusBanner
          action={
            <Button
              variant="text"
              size="compact"
              onClick={() =>
                mark.mutate(
                  { occurrence: { id: marked.id, version: 1 }, status: "scheduled" },
                  { onSuccess: () => setMarked(null) },
                )
              }
            >
              Undo
            </Button>
          }
        >
          {`${marked.name} marked as ${marked.status}. MoneyPilot only records it; it doesn’t move any money.`}
        </StatusBanner>
      )}
      <div className={lists.actions}>
        <Button disabled={!row.occurrenceId || mark.isPending} onClick={markNow}>
          {income ? "Mark as received" : "Mark as paid"}
        </Button>
        <Button variant="secondary" disabled title="Editing arrives with the item forms (Q-164)">
          Edit
        </Button>
      </div>
    </aside>
  );
}
