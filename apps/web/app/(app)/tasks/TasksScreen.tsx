"use client";

import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Loading,
  SegmentedControl,
  SelectField,
  Skeleton,
  TextField,
} from "@mp/ui";
import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";
import { money } from "@mp/format";
import { PageHeader } from "../../../lib/components/PageHeader";
import { OwnerCell } from "../../../lib/components/OwnerCell";
import { shortDate } from "../../../lib/format/dates";
import { useCompleteTask, useCreateTask, useRenewals, useTasks, useToday } from "../../../lib/lists/hooks";
import type { Task, TaskGroups } from "../../../lib/lists/hooks";
import { useOwners } from "../../../lib/owners";
import type { Owners } from "../../../lib/owners";
import styles from "./tasks.module.css";

const ownerKey = (t: Task): string => t.ownerUserId ?? t.ownerType;

/** Rule 13: a partner's filter includes their own tasks plus Both and Split. */
const visible = (t: Task, filter: string): boolean =>
  filter === "all" || t.ownerType !== "member" || t.ownerUserId === filter;

function source(task: Task, owners: Owners): string {
  const by = task.createdBy ? owners.member(task.createdBy)?.name : null;
  switch (task.source) {
    case "engine":
      // The canvas drops "Suggested by MoneyPilot" when the task completes itself.
      return task.autoCompleteRule
        ? "Completes itself if the bill arrives by email"
        : "Suggested by MoneyPilot";
    case "email":
      return "From email";
    case "renewal":
      return "Renewal reminder";
    case "setup":
      return "Setup";
    default:
      return by ? `Added by ${by}` : "Added by hand";
  }
}

function TaskRow({
  task,
  today,
  soon,
  owners,
  pending,
  amounts,
  onToggle,
}: {
  task: Task;
  today: string;
  soon: boolean;
  owners: Owners;
  pending: boolean;
  amounts: ReadonlyMap<string, number>;
  onToggle: (task: Task, completed: boolean) => void;
}) {
  const amountCents = task.linkedItemId ? amounts.get(task.linkedItemId) : undefined;
  const due = task.completed
    ? `Done ${task.completedAt ? shortDate(task.completedAt.slice(0, 10), today) : ""}`.trim()
    : (task.dueHint ?? (task.dueOn ? shortDate(task.dueOn, today, { weekday: true }) : "No date"));
  const href = task.source === "renewal" || task.source === "email" ? "/renewals" : "/bills";
  return (
    <li className={styles.row}>
      <Checkbox
        className={styles.check}
        strikeWhenChecked
        checked={task.completed}
        disabled={pending}
        onChange={(e) => onToggle(task, e.target.checked)}
        label={task.title}
      />
      <div className={styles.meta}>
        {soon ? <span className={styles.dueSoon}>{due}</span> : <span className={styles.due}>{due}</span>}
        {task.linkedItemName && (
          <Link href={href} className={styles.link}>
            {amountCents === undefined
              ? task.linkedItemName
              : `${task.linkedItemName} · ${money(amountCents, { mode: "detail" })}`}
          </Link>
        )}
        <span>{source(task, owners)}</span>
      </div>
      <span className={styles.avatar}>
        <OwnerCell ownerId={ownerKey(task)} owners={owners} size={28} showName={false} combined />
      </span>
    </li>
  );
}

function Group({
  title,
  tasks,
  empty,
  soon = false,
  ...rest
}: {
  title: string;
  tasks: readonly Task[];
  empty: string;
  soon?: boolean;
  today: string;
  owners: Owners;
  pending: boolean;
  amounts: ReadonlyMap<string, number>;
  onToggle: (task: Task, completed: boolean) => void;
}) {
  return (
    <Card
      className={styles.group}
      title={title}
      actions={
        <span className={styles.count}>{`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}</span>
      }
    >
      {tasks.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className={styles.list}>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} soon={soon} {...rest} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddTask({ owners }: { owners: Owners }) {
  const create = useCreateTask();
  const [title, setTitle] = useState("");
  const [who, setWho] = useState(owners.members[0]?.id ?? "both");
  const [dueOn, setDueOn] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    const member = owners.member(who);
    create.mutate(
      {
        title: text,
        ownerType: member ? "member" : "both",
        ownerUserId: member?.id ?? null,
        dueOn: dueOn || null,
      },
      { onSuccess: () => setTitle("") },
    );
  }

  return (
    <form aria-label="Add a task" className={styles.form} onSubmit={submit}>
      <TextField
        className={styles.formTitle}
        label="New task"
        placeholder="e.g. Call the insurer about the renewal"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={create.isError ? "We couldn’t add that task. Your text is still here; try again." : undefined}
      />
      <SelectField
        className={styles.formOwner}
        label="Owner"
        value={who}
        onChange={(e) => setWho(e.target.value)}
        options={[
          ...owners.members.map((m) => ({ value: m.id, label: m.name })),
          { value: "both", label: "Both" },
        ]}
      />
      <TextField
        className={styles.formDue}
        label="Due"
        type="date"
        value={dueOn}
        onChange={(e) => setDueOn(e.target.value)}
      />
      <Button type="submit" disabled={create.isPending || title.trim() === ""}>
        Add task
      </Button>
    </form>
  );
}

function Aside({ groups, owners }: { groups: TaskGroups; owners: Owners }) {
  const open = [...groups.dueThisWeek, ...groups.later];
  const count = (pred: (t: Task) => boolean) => open.filter(pred).length;
  return (
    <aside className={styles.aside}>
      <Card title="Open tasks">
        <ul className={styles.counts}>
          {owners.members.map((m) => (
            <li key={m.id}>
              <OwnerCell ownerId={m.id} owners={owners} size={24} />
              <strong>{count((t) => t.ownerUserId === m.id)}</strong>
            </li>
          ))}
          <li>
            <OwnerCell ownerId="both" owners={owners} size={24} combined />
            <strong>{count((t) => t.ownerType !== "member")}</strong>
          </li>
        </ul>
      </Card>
      <Card title="Where tasks come from">
        <ul className={styles.sources}>
          <li>
            <strong>You:</strong> anything you add here or from a bill.
          </li>
          <li>
            <strong>MoneyPilot:</strong> flags such as a price increase or an estimate to confirm.
          </li>
          <li>
            <strong>Email:</strong> deadlines in renewal and enrollment emails.
          </li>
        </ul>
        <p className={styles.caption}>
          Reminders go to the owner only. Some tasks complete themselves, for example when the actual
          electricity bill arrives by email.
        </p>
      </Card>
    </aside>
  );
}

export function TasksScreen() {
  const tasks = useTasks();
  const today = useToday();
  const owners = useOwners();
  const complete = useCompleteTask();
  const renewals = useRenewals();
  const [filter, setFilter] = useState("all");

  const header = (actions?: React.ReactNode) => (
    <PageHeader
      overline="Who does what"
      title="Household tasks"
      subtitle="Every money to-do has one owner and a date. Both of you see everything."
      actions={actions}
    />
  );

  if (tasks.isError) {
    return (
      <>
        {header()}
        <ErrorBanner title="We couldn’t load your tasks." onRetry={() => void tasks.refetch()}>
          Your bills and plan are unaffected.
        </ErrorBanner>
      </>
    );
  }
  if (!tasks.data || !today || !owners) {
    return (
      <>
        {header()}
        <Loading label="Loading tasks">
          <Skeleton shape="block" height="96px" />
          <Skeleton shape="block" height="240px" />
        </Loading>
      </>
    );
  }
  const groups = tasks.data;
  const shown = (list: readonly Task[]) => list.filter((t) => visible(t, filter));
  // The canvas writes the amount after a renewal's name ("Car insurance · $684"). It comes from the
  // renewals list, never computed here; a monthly premium is not the renewal's cost, so it has none.
  const amounts = new Map<string, number>();
  for (const r of renewals.data ?? []) {
    if (r.every.unit === "month" && r.every.n === 1) continue;
    amounts.set(r.id, r.amountCents);
    if (r.itemId) amounts.set(r.itemId, r.amountCents);
  }
  const common = {
    today,
    owners,
    amounts,
    pending: complete.isPending,
    onToggle: (task: Task, completed: boolean) => complete.mutate({ task, completed }),
  };
  return (
    <>
      {header(
        <SegmentedControl
          label="Filter by owner"
          onCanvas
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Both" },
            ...owners.members.map((m) => ({ value: m.id, label: m.name })),
          ]}
        />,
      )}
      <div className={styles.body}>
        <div className={styles.main}>
          <AddTask owners={owners} />
          {complete.isError && (
            <ErrorBanner title="We couldn’t save that change.">
              The task is unchanged. Check the box again to retry.
            </ErrorBanner>
          )}
          <Group
            title="Due this week"
            tasks={shown(groups.dueThisWeek)}
            empty="Nothing due this week."
            soon
            {...common}
          />
          <Group title="Later" tasks={shown(groups.later)} empty="Nothing scheduled later." {...common} />
          <Group title="Done" tasks={shown(groups.done)} empty="Finished tasks show up here." {...common} />
        </div>
        <Aside groups={groups} owners={owners} />
      </div>
    </>
  );
}
