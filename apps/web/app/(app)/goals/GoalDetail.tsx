"use client";

import { money } from "@mp/format";
import { Button, Stepper, StatusBanner } from "@mp/ui";
import Link from "next/link";
import { shortDate } from "../../../lib/format/dates";
import { useGoalOptions, useGoalPreview, usePatchGoal } from "../../../lib/lists/hooks";
import type { Goal, GoalPreview, Proposal } from "../../../lib/lists/hooks";
import lists from "../../../lib/lists/lists.module.css";
import { dollars, kindLabel, targetLine } from "./derive";
import styles from "./goals.module.css";

function GoalMath({ preview }: { preview: GoalPreview }) {
  return (
    <div className={styles.math}>
      <p className={lists.overline}>The math</p>
      <dl className={styles.mathRows}>
        {preview.math.map((row) => (
          <div
            key={row.label}
            className={`${styles.mathRow} ${row.kind === "total" ? styles.mathTotal : ""}`}
          >
            <dt>{row.label}</dt>
            <dd>{row.cents === null ? "" : money(row.cents, { mode: "detail" })}</dd>
          </div>
        ))}
        <div className={`${styles.mathRow} ${styles.mathResult}`}>
          <dt>Result</dt>
          <dd className={preview.result.onTrack ? styles.ok : styles.attention}>{preview.result.text}</dd>
        </div>
      </dl>
    </div>
  );
}

export function GoalDetail({
  goal,
  today,
  draftCents,
  onDraft,
  partnerName,
  pending,
}: {
  goal: Goal;
  today: string;
  /** The stepper's value, or null while it shows the saved amount. */
  draftCents: number | null;
  onDraft: (monthlyCents: number | null) => void;
  partnerName: string;
  /** The pending proposal for this goal's monthly amount, if any. */
  pending: Proposal | null;
}) {
  const monthly = draftCents ?? goal.monthlyCents;
  const preview = useGoalPreview(goal.id, monthly);
  const options = useGoalOptions(goal.id);
  const patch = usePatchGoal();
  const progress = preview.data?.progress ?? goal.progress;
  const behind = progress.status === "behind" || progress.status === "to_set_aside";
  const suggested = progress.suggestedMonthlyCents;
  const changed = draftCents !== null && draftCents !== goal.monthlyCents;
  const sent = patch.data?.kind === "pending" ? patch.data.proposal : null;
  const waiting = sent ?? pending;
  const waitingAmount =
    waiting && waiting.payload.type === "goal_monthly" ? waiting.payload.toMonthlyCents : null;
  const otherWays = (options.data?.options ?? []).flatMap((o) =>
    o.kind === "move_date"
      ? [`move the date to ${shortDate(o.targetDate, today)}`]
      : o.kind === "lower_target"
        ? [`lower the target to ${dollars(o.targetCents)}`]
        : [],
  );

  return (
    <aside className={lists.aside} aria-label="Selected goal">
      <div>
        <p className={lists.overline}>{kindLabel(goal)}</p>
        <h2 className={lists.asideTitle}>{goal.name}</h2>
        <p className={lists.muted}>{targetLine(goal, today)}</p>
      </div>
      <div className={styles.stepBlock}>
        <Stepper
          label={
            goal.type === "planned_expense" && goal.targetDate
              ? `Set aside each month until ${shortDate(goal.targetDate, today)}`
              : "Monthly deposit"
          }
          valueCents={monthly}
          onChange={(cents) => onDraft(cents === goal.monthlyCents ? null : cents)}
        />
        {behind && suggested !== null && suggested !== monthly && (
          <button type="button" className={styles.suggest} onClick={() => onDraft(suggested)}>
            {`Use ${dollars(suggested)} a month to stay on track`}
          </button>
        )}
        {behind && otherWays.length > 0 && (
          <p className={lists.muted}>{`Other ways to close the gap: ${otherWays.join(", or ")}.`}</p>
        )}
      </div>
      {preview.data && <GoalMath preview={preview.data} />}
      {waiting && (
        <StatusBanner>
          {waitingAmount !== null
            ? `Waiting for ${partnerName} to approve ${dollars(waitingAmount)} a month for ${goal.name}. Nothing changes until they do.`
            : `Waiting for ${partnerName} to approve a change to ${goal.name}.`}
        </StatusBanner>
      )}
      {patch.isError && (
        <p role="alert" className={styles.attention}>
          We couldn’t send that. Your amount is still here; try again.
        </p>
      )}
      <div className={lists.actions}>
        <Button
          disabled={!changed || patch.isPending}
          onClick={() => {
            if (draftCents === null) return;
            patch.mutate({ goal, body: { monthlyCents: draftCents } }, { onSuccess: () => onDraft(null) });
          }}
        >
          {`Ask ${partnerName} to approve`}
        </Button>
        <Link href="/ask" className={styles.linkButton}>
          Ask MoneyPilot
        </Link>
      </div>
      <p className={lists.footer}>
        Changes take effect after both partners approve. Calculated by MoneyPilot’s planning rules: one
        deposit per month on the first payday.
      </p>
    </aside>
  );
}
