"use client";

import {
  Card,
  EmptyState,
  ErrorBanner,
  Loading,
  Skeleton,
  StatusBanner,
  StatusChip,
  TextField,
} from "@mp/ui";
import { useState } from "react";
import { useDecide, useItemNames, useReviewItems, useToday } from "../../../lib/api/imports-hooks";
import type { EditFields, ReviewItem } from "../../../lib/api/imports-types";
import { usePlan, useSummary } from "../../../lib/api/hooks";
import { problemMessage } from "../../../lib/api/messages";
import { ReviewQueueItem } from "@mp/ui";
import { ConfirmDialog } from "../../../lib/components/ConfirmDialog";
import { localDate, parseDollars } from "../../../lib/format/input";
import { money } from "@mp/format";
import { parseDate } from "../../../lib/format/dates";
import { decisionMessage, effectText, reviewFields, reviewTitle, reviewTag } from "./review-map";
import styles from "./imports.module.css";

function countLabel(n: number): string {
  return `${n} to review`;
}

type DateKey = "dueDate" | "renewalDate" | "decisionByDate";

function dateKeyOf(item: ReviewItem): DateKey | null {
  const f = item.fields;
  if (f.decisionByDate) return "decisionByDate";
  if (f.renewalDate) return "renewalDate";
  if (f.dueDate) return "dueDate";
  return null;
}

/** Edit: correct the amount or the date, then the item is applied as edited. */
function EditDialog({
  item,
  title,
  busy,
  error,
  onSave,
  onCancel,
}: {
  item: ReviewItem;
  title: string;
  busy: boolean;
  error: string | null;
  onSave: (fields: EditFields) => void;
  onCancel: () => void;
}) {
  const dateKey = dateKeyOf(item);
  const [amount, setAmount] = useState(
    item.fields.amountDueCents === null ? "" : money(item.fields.amountDueCents, { mode: "detail" }),
  );
  const [date, setDate] = useState(dateKey ? (item.fields[dateKey] ?? "") : "");
  const [problem, setProblem] = useState<string | null>(null);

  const save = () => {
    const fields: EditFields = {};
    if (item.fields.amountDueCents !== null) {
      const cents = parseDollars(amount);
      if (cents === null) {
        setProblem("Enter the amount as dollars, like $151.37.");
        return;
      }
      if (cents !== item.fields.amountDueCents) fields.amountDueCents = cents;
    }
    if (dateKey && date && date !== item.fields[dateKey]) fields[dateKey] = date;
    if (Object.keys(fields).length === 0) {
      setProblem("Change an amount or a date, or cancel and use Confirm.");
      return;
    }
    setProblem(null);
    onSave(fields);
  };

  const dateLabel = dateKey === "renewalDate" ? "Renews" : dateKey === "decisionByDate" ? "Deadline" : "Due";
  return (
    <ConfirmDialog
      title={`Edit ${title}`}
      confirmLabel="Save and apply"
      busy={busy}
      error={problem ?? error}
      onConfirm={save}
      onCancel={onCancel}
    >
      <p>Fix what we read. The item is applied with your values.</p>
      {item.fields.amountDueCents !== null && (
        <TextField label="Amount" money value={amount} onChange={(e) => setAmount(e.target.value)} />
      )}
      {dateKey && (
        <TextField label={dateLabel} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      )}
    </ConfirmDialog>
  );
}

/** "Review what we found": the queue, its status banner and the empty state. */
export function ReviewCard() {
  const items = useReviewItems();
  const decide = useDecide();
  const names = useItemNames();
  const plan = usePlan();
  const today = useToday();
  const zone = useSummary().data?.household.timezone ?? "America/New_York";
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReviewItem | null>(null);

  const run = (item: ReviewItem, kind: "confirm" | "edit" | "ignore", fields?: EditFields) => {
    setFailure(null);
    // The engine's safe to spend as the page shows it now, to tell whether this decision changed it.
    const before = plan.data?.safeToSpendCents ?? null;
    decide.mutate(
      { id: item.id, kind, fields },
      {
        onSuccess: (decision) => {
          setMessage(decisionMessage(decision, kind, before));
          setEditing(null);
        },
        onError: (error) =>
          setFailure(problemMessage(error, "We couldn’t save that. Nothing was changed. Try again.")),
      },
    );
  };

  const queue = items.data ?? [];
  const titleOf = (item: ReviewItem) =>
    reviewTitle(item, item.matchItemId ? (names.data?.get(item.matchItemId) ?? null) : null);
  const [year] = today.split("-").map(Number) as [number];

  return (
    <Card
      title="Review what we found"
      actions={
        items.data ? <StatusChip variant="attention">{countLabel(queue.length)}</StatusChip> : undefined
      }
    >
      <div className={styles.stack}>
        {message && <StatusBanner>{message}</StatusBanner>}
        {failure && !editing && <ErrorBanner title="That didn’t go through.">{failure}</ErrorBanner>}
        {items.isError && (
          <ErrorBanner title="We couldn’t load the review queue." onRetry={() => void items.refetch()}>
            Your bills and plan are unchanged.
          </ErrorBanner>
        )}
        {items.isPending && (
          <Loading label="Loading what we found">
            <Skeleton shape="block" height="160px" />
            <Skeleton shape="block" height="160px" />
          </Loading>
        )}
        {items.data && queue.length === 0 && (
          <EmptyState>All caught up. New bills and renewals will appear here as they arrive.</EmptyState>
        )}
        {queue.map((item) => (
          <ReviewQueueItem
            key={item.id}
            title={titleOf(item)}
            tag={reviewTag(item)}
            sender={
              item.source === "csv"
                ? "Bank CSV"
                : (item.fields.providerName ?? item.message?.fromDomain ?? "Unknown sender")
            }
            subject={
              item.source === "csv"
                ? "A repeating charge found in your file"
                : (item.message?.subject ?? "No subject")
            }
            receivedOn={parseLocal(item.message?.receivedAt ?? item.createdAt, zone)}
            today={{ year }}
            fields={reviewFields(item.fields)}
            effect={effectText(item)}
            busy={decide.isPending}
            onConfirm={() => run(item, "confirm")}
            onEdit={() => {
              setFailure(null);
              setEditing(item);
            }}
            onIgnore={() => run(item, "ignore")}
          />
        ))}
      </div>
      {editing && (
        <EditDialog
          item={editing}
          title={titleOf(editing)}
          busy={decide.isPending}
          error={failure}
          onSave={(fields) => run(editing, "edit", fields)}
          onCancel={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function parseLocal(timestamp: string, timeZone: string) {
  return parseDate(localDate(timestamp, timeZone));
}
