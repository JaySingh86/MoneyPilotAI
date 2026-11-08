"use client";

import { money } from "@mp/format";
import { Card, Checkbox, EmptyState, ErrorBanner, IconButton, ProgressBar } from "@mp/ui";
import type { ProgressTone } from "@mp/ui";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Goal, PlanResponse, Task } from "../../../lib/api/planning-types";
import { useCompleteTask, useTasks } from "../../../lib/lists/hooks";
import { OwnerCell } from "../../../lib/components/OwnerCell";
import { shortDate } from "../../../lib/format/dates";
import type { Owners } from "../../../lib/owners";
import styles from "./overview.module.css";

const TONES: readonly ProgressTone[] = ["brand", "partnerA", "partnerB"];
const dollars = (cents: number) => money(cents, { mode: "headline", rounding: "nearest" });

function GoalStatus({ goal }: { goal: Goal }) {
  const { status, gapCents } = goal.progress;
  if (status === "behind" && gapCents !== null) {
    return <span className={styles.behind}>{`${dollars(gapCents)} behind`}</span>;
  }
  if (goal.type === "planned_expense") return <span>Planned expense</span>;
  if (status === "reached") return <span>Reached</span>;
  if (status === "on_track") return <span>On track</span>;
  if (goal.monthlyCents > 0) return <span>{`${dollars(goal.monthlyCents)} on payday`}</span>;
  return null;
}

export function Goals({ goals, asOf }: { goals: readonly Goal[]; asOf: string }) {
  const router = useRouter();
  return (
    <Card
      title="Goals & planned expenses"
      actions={<IconButton icon={Plus} label="Add goal" onClick={() => router.push("/goals")} />}
    >
      {goals.length === 0 ? (
        <EmptyState>No goals yet. Add one to see how much to set aside each payday.</EmptyState>
      ) : (
        <div className={styles.goals}>
          {goals.map((g) => (
            <ProgressBar
              key={g.id}
              title={
                g.targetDate && !g.isEmergencyFund ? `${g.name} · ${shortDate(g.targetDate, asOf)}` : g.name
              }
              percent={g.progress.percent}
              tone={TONES[g.colorSlot - 1] ?? "brand"}
              caption={
                <span className={styles.captionRow}>
                  <span>
                    {g.type === "planned_expense"
                      ? `${dollars(g.savedCents)} set aside of ${dollars(g.targetCents)}`
                      : `${dollars(g.savedCents)} of ${dollars(g.targetCents)}`}
                  </span>
                  <GoalStatus goal={g} />
                </span>
              }
            />
          ))}
        </div>
      )}
    </Card>
  );
}

const taskOwner = (t: Task): string => t.ownerUserId ?? t.ownerType;

function taskMeta(task: Task, owners: Owners, asOf: string): string {
  const owner = owners.label(taskOwner(task));
  if (task.completed) return `${owner} · done ${task.dueOn ? shortDate(task.dueOn, asOf) : ""}`.trim();
  if (task.dueHint) return `${owner} · ${task.dueHint}`;
  return task.dueOn ? `${owner} · by ${shortDate(task.dueOn, asOf, { weekday: true })}` : owner;
}

export function Tasks({ plan, owners }: { plan: PlanResponse; owners: Owners }) {
  // The tasks API (WP-13) is the source: due within 7 days, plus the latest done. Checking one saves it.
  const groups = useTasks();
  const complete = useCompleteTask();
  // Canvas "Web · Overview" lists the week's tasks latest date first, then the latest done.
  const tasks = groups.data
    ? [
        ...[...groups.data.dueThisWeek].sort((a, b) => (b.dueOn ?? "").localeCompare(a.dueOn ?? "")),
        ...groups.data.done.slice(0, 1),
      ]
    : [];
  return (
    <Card title="Household tasks">
      {groups.isError ? (
        <ErrorBanner title="We couldn’t load your tasks." onRetry={() => void groups.refetch()}>
          The rest of your plan is unaffected.
        </ErrorBanner>
      ) : tasks.length === 0 ? (
        <EmptyState>Nothing is due this week. Tasks from bills and renewals will appear here.</EmptyState>
      ) : (
        <ul className={styles.tasks}>
          {tasks.map((t) => (
            <li key={t.id} className={styles.task}>
              <Checkbox
                strikeWhenChecked
                checked={t.completed}
                disabled={complete.isPending}
                onChange={(e) => complete.mutate({ task: t, completed: e.target.checked })}
                label={
                  <>
                    {t.title}
                    <span className={styles.taskMeta}>{taskMeta(t, owners, plan.asOf)}</span>
                  </>
                }
              />
              <OwnerCell ownerId={taskOwner(t)} owners={owners} size={24} showName={false} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
