"use client";

import {
  Amount,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  KpiTile,
  Loading,
  ProgressBar,
  RadioCardGroup,
  SelectField,
  Skeleton,
  StatusBanner,
  StatusChip,
  Table,
  TextField,
  TwoLineCell,
} from "@mp/ui";
import type { TableColumn } from "@mp/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { usePlan, useSummary } from "../../../lib/api/hooks";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { PageHeader } from "../../../lib/components/PageHeader";
import { shortDate, shortDateNoYear } from "../../../lib/format/dates";
import {
  useBillsItems,
  useCreateGoal,
  useGoalPreview,
  useGoals,
  usePlannedExpenses,
  useProposals,
  useRenewals,
} from "../../../lib/lists/hooks";
import type { Goal, GoalList } from "../../../lib/lists/hooks";
import lists from "../../../lib/lists/lists.module.css";
import { useOwners } from "../../../lib/owners";
import type { Owners } from "../../../lib/owners";
import { GoalDetail } from "./GoalDetail";
import {
  TONES,
  amountsLine,
  dollars,
  isOk,
  kindLabel,
  parseDollars,
  plannedRows,
  statusText,
} from "./derive";
import type { PlannedRow } from "./derive";
import styles from "./goals.module.css";

function NewGoal({
  partnerName,
  slot,
  onDone,
}: {
  partnerName: string;
  /** The progress-bar color: goals take brand, partner A, partner B in order. */
  slot: number;
  onDone: (message: string) => void;
}) {
  const create = useCreateGoal();
  const [name, setName] = useState("");
  const [type, setType] = useState<"savings" | "planned_expense">("savings");
  const [target, setTarget] = useState("");
  const [monthly, setMonthly] = useState("");
  const [date, setDate] = useState("");
  const targetCents = parseDollars(target);
  const monthlyCents = monthly.trim() === "" ? 0 : parseDollars(monthly);
  const targetError =
    target !== "" && (targetCents === null || targetCents < 100) ? "Enter an amount like 2,400." : undefined;
  const monthlyError = monthlyCents === null ? "Enter an amount like 250, or leave it empty." : undefined;
  const valid = name.trim() !== "" && targetCents !== null && targetCents >= 100 && monthlyCents !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || targetCents === null || monthlyCents === null) return;
    create.mutate(
      {
        name: name.trim(),
        type,
        targetCents,
        monthlyCents,
        targetDate: date || null,
        savedCents: 0,
        colorSlot: slot,
        isEmergencyFund: false,
      },
      {
        onSuccess: (result) =>
          onDone(
            result.kind === "pending" && result.proposal.payload.type === "goal_monthly"
              ? `${name.trim()} is created. Its ${dollars(result.proposal.payload.toMonthlyCents)} a month is waiting for ${partnerName} to approve.`
              : `${name.trim()} is created.`,
          ),
      },
    );
  }

  return (
    <Card
      title="New goal"
      subtitle="A monthly amount is a change to the shared plan, so the other member approves it."
    >
      <form aria-label="New goal" className={styles.newGoal} onSubmit={submit}>
        <TextField
          className={styles.newGoalWide}
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label="Kind"
          value={type}
          onChange={(e) => setType(e.target.value === "planned_expense" ? "planned_expense" : "savings")}
          options={[
            { value: "savings", label: "Goal" },
            { value: "planned_expense", label: "Planned expense" },
          ]}
        />
        <TextField
          label="Target"
          money
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          error={targetError}
        />
        <TextField
          label="Per month"
          money
          value={monthly}
          onChange={(e) => setMonthly(e.target.value)}
          error={monthlyError}
        />
        <TextField label="Target date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Button type="submit" disabled={!valid || create.isPending}>
          Create goal
        </Button>
        {create.isError && (
          <p role="alert" className={styles.attention}>
            We couldn’t create that goal. What you typed is still here; try again.
          </p>
        )}
      </form>
    </Card>
  );
}

/** The first name of whoever's pay sets the household's payday, once it is known. */
function usePrimaryPayer(owners: Owners | null): string | null {
  const summary = useSummary();
  const items = useBillsItems();
  const itemId = summary.data?.household.primaryIncomeItemId;
  const item = itemId ? items.data?.items.find((i) => i.id === itemId) : undefined;
  return (item?.ownerUserId ? owners?.member(item.ownerUserId)?.name : null) ?? null;
}

const subtitle = (payer: string | null): string =>
  `Transfers are reminders on ${payer ? `${payer}’s ` : ""}payday. You move the money yourselves.`;

function Loaded({ list, today, owners }: { list: GoalList; today: string; owners: Owners }) {
  const { me } = useAuth();
  const planned = usePlannedExpenses();
  const renewals = useRenewals();
  const proposals = useProposals();
  const payer = usePrimaryPayer(owners);
  const [picked, setPicked] = useState<string | null>(null);
  // One draft at a time: moving to another goal drops it (nothing was sent).
  const [draft, setDraft] = useState<{ goalId: string; cents: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const goals = list.data;
  // The canvas opens on the goal that needs a decision: the first one that is behind, then the first
  // planned expense with something left to set aside, then the first goal.
  const needsAttention =
    goals.find((g) => g.progress.status === "behind") ??
    goals.find((g) => g.progress.status === "to_set_aside");
  const selected = goals.find((g) => g.id === picked) ?? needsAttention ?? goals[0];
  const partner = owners.members.find((m) => m.id !== me?.id);
  const partnerName = partner?.name ?? "your partner";
  const activeDraft = draft && selected && draft.goalId === selected.id ? draft.cents : null;
  const preview = useGoalPreview(selected?.id ?? null, activeDraft);
  const saving =
    activeDraft !== null && preview.data?.monthlyCents === activeDraft
      ? preview.data.savingEachMonthCents
      : list.savingEachMonthCents;
  const pending =
    (proposals.data ?? []).find(
      (p) => selected && p.payload.type === "goal_monthly" && p.payload.goalId === selected.id,
    ) ?? null;
  const savingsGoals = goals.filter((g) => g.type === "savings").length;
  const plannedGoals = goals.length - savingsGoals;

  const rows = plannedRows(planned.data ?? [], goals, renewals.data ?? [], owners.label, today);
  const columns: ReadonlyArray<TableColumn<PlannedRow>> = [
    { key: "date", header: "Date", render: (r) => <strong>{shortDateNoYear(r.date)}</strong> },
    {
      key: "name",
      header: "Expense",
      rowHeader: true,
      render: (r) => <TwoLineCell title={r.name} meta={r.meta} />,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusChip variant={r.chip.variant}>{r.chip.text}</StatusChip>,
    },
    { key: "amount", header: "Amount", align: "end", render: (r) => <Amount cents={r.amountCents} /> },
  ];

  return (
    <>
      <PageHeader
        overline="Saving together"
        title="Goals & planned expenses"
        subtitle={subtitle(payer)}
        actions={
          <Button icon={Plus} aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
            New goal
          </Button>
        }
      />

      {notice && <StatusBanner>{notice}</StatusBanner>}

      <div className={lists.kpiRow}>
        <KpiTile
          className={lists.heroTile}
          label="Saving each month"
          value={{ cents: saving, mode: "headline", rounding: "nearest" }}
          caption={
            list.nextTransferOn
              ? `Next transfer reminder: ${shortDate(list.nextTransferOn, today, { weekday: true })}`
              : "No transfer reminders yet"
          }
        />
        <KpiTile
          label="Saved so far"
          value={{ cents: list.savedSoFarCents, mode: "headline", rounding: "nearest" }}
          caption={`Across ${savingsGoals} ${savingsGoals === 1 ? "goal" : "goals"} and ${plannedGoals} planned ${plannedGoals === 1 ? "expense" : "expenses"}`}
        />
        <KpiTile
          label="Effect on safe to spend"
          value={{ cents: list.effectOnSafeToSpendCents, mode: "headline" }}
          caption={
            list.effectOnSafeToSpendCents === 0
              ? "Transfers happen on payday, after this period ends"
              : "Goal transfers that land before payday"
          }
        />
      </div>

      {adding && (
        <NewGoal
          partnerName={partnerName}
          slot={(goals.length % 3) + 1}
          onDone={(message) => {
            setAdding(false);
            setNotice(message);
          }}
        />
      )}

      <div className={lists.layout}>
        <div className={lists.main}>
          {goals.length === 0 ? (
            <Card>
              <EmptyState>No goals yet. Add one to see how much to set aside each payday.</EmptyState>
            </Card>
          ) : (
            <RadioCardGroup
              label="Goals"
              variant="goal"
              layout="grid"
              hideIndicator
              value={selected?.id ?? null}
              onChange={setPicked}
              options={goals.map((g: Goal) => ({
                value: g.id,
                title: g.name,
                overline: kindLabel(g),
                overlineEnd: `${g.progress.percent}%`,
                children: (
                  <>
                    <ProgressBar
                      variant="bare"
                      title={`${g.name} progress`}
                      percent={g.progress.percent}
                      tone={TONES[g.colorSlot as 1 | 2 | 3] ?? "brand"}
                      caption={amountsLine(g)}
                    />
                    <StatusChip
                      className={styles.statusChip}
                      variant={isOk(g.progress.status) ? "ok" : "attention"}
                    >
                      {statusText(g, today)}
                    </StatusChip>
                  </>
                ),
              }))}
            />
          )}

          <Card
            title="Planned expenses ahead"
            subtitle="One-off costs you know are coming. They’re counted in the month they happen."
          >
            <Table
              caption="Planned expenses by date"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.key}
              empty={
                <EmptyState>
                  No planned expenses yet. One-off costs you add will appear here by date.
                </EmptyState>
              }
            />
          </Card>
        </div>
        {selected && (
          <GoalDetail
            key={selected.id}
            goal={selected}
            today={today}
            draftCents={activeDraft}
            onDraft={(cents) => setDraft(cents === null ? null : { goalId: selected.id, cents })}
            partnerName={partnerName}
            payerName={payer}
            pending={pending}
          />
        )}
      </div>
      <p className={lists.footer}>Sample data · All amounts in USD</p>
    </>
  );
}

export function GoalsScreen() {
  const plan = usePlan();
  const goals = useGoals();
  const owners = useOwners();
  const payer = usePrimaryPayer(owners);
  const header = (
    <PageHeader overline="Saving together" title="Goals & planned expenses" subtitle={subtitle(payer)} />
  );
  if (goals.isError || plan.isError) {
    return (
      <>
        {header}
        <ErrorBanner
          title="We couldn’t load your goals."
          onRetry={() => {
            void goals.refetch();
            void plan.refetch();
          }}
        >
          Nothing was changed. Your plan on the Overview is unaffected.
        </ErrorBanner>
      </>
    );
  }
  if (!goals.data || !plan.data || !owners) {
    return (
      <>
        {header}
        <Loading label="Loading goals">
          <Skeleton shape="block" height="120px" />
          <Skeleton shape="block" height="360px" />
        </Loading>
      </>
    );
  }
  return <Loaded list={goals.data} today={plan.data.asOf} owners={owners} />;
}
