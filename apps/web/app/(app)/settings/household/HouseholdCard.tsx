"use client";

import { money } from "@mp/format";
import { Button, Card, ErrorBanner, Loading, SelectField, Skeleton, StatusBanner, TextField } from "@mp/ui";
import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";
import { useSummary } from "../../../../lib/api/hooks";
import { problemMessage } from "../../../../lib/api/messages";
import { useBilling, useIncomeItems, usePatchHousehold } from "../../../../lib/api/settings-hooks";
import type { Item } from "../../../../lib/api/settings-hooks";
import { parseDate, shortDate } from "../../../../lib/format/dates";
import { localDate, parseDollars } from "../../../../lib/format/input";
import styles from "./household.module.css";

const WEEKDAY = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
} as const;
const WEEKDAYS = Object.values(WEEKDAY);

/** "every other Friday", "last Friday" from the item's schedule. */
function scheduleLabel(item: Item): string {
  const s = item.schedule;
  switch (s.type) {
    case "every_n_weeks": {
      const day = WEEKDAYS[parseDate(s.dtstart).dayOfWeek - 1];
      return s.n === 2 ? `every other ${day}` : `every ${s.n} weeks`;
    }
    case "monthly_last_weekday":
      return `last ${WEEKDAY[s.weekday]}`;
    case "monthly_day":
      return `monthly on day ${s.day}`;
    case "monthly_last_day":
      return "last day of the month";
    case "every_n_months":
      return `every ${s.n} months`;
    case "yearly":
      return "yearly";
  }
}

/** Household name, payday income, cushion and plan. Saved with one button; the plan recalculates. */
export function HouseholdCard() {
  const summary = useSummary();
  const incomes = useIncomeItems();
  const billing = useBilling();
  const patch = usePatchHousehold();
  const household = summary.data?.household;

  const [name, setName] = useState<string | null>(null);
  const [income, setIncome] = useState<string | null>(null);
  const [cushion, setCushion] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ name?: string; cushion?: string }>({});
  const [saved, setSaved] = useState(false);

  if (!household) {
    return (
      <Card title="Household">
        {summary.isError ? (
          <ErrorBanner title="We couldn’t load your household." onRetry={() => void summary.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        ) : (
          <Loading label="Loading your household">
            <Skeleton shape="block" height="220px" />
          </Loading>
        )}
      </Card>
    );
  }
  const nameValue = name ?? household.name;
  const incomeValue = income ?? household.primaryIncomeItemId ?? "";
  const cushionValue = cushion ?? money(household.cushionCents, { mode: "headline", rounding: "nearest" });
  const dirty = name !== null || income !== null || cushion !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: { name?: string; cushionCents?: number; primaryIncomeItemId?: string } = {};
    const errors: { name?: string; cushion?: string } = {};
    if (name !== null) {
      if (name.trim() === "" || name.trim().length > 80) errors.name = "Use 1 to 80 characters.";
      else next.name = name.trim();
    }
    if (cushion !== null) {
      const cents = parseDollars(cushion);
      if (cents === null) errors.cushion = "Enter dollars, like $500.";
      else next.cushionCents = cents;
    }
    if (income !== null && income !== "") next.primaryIncomeItemId = income;
    setProblems(errors);
    if (Object.keys(errors).length > 0) return;
    setSaved(false);
    patch.mutate(next, {
      onSuccess: () => {
        setName(null);
        setIncome(null);
        setCushion(null);
        setSaved(true);
      },
    });
  };

  const options = (incomes.data ?? []).map((item) => ({
    value: item.id,
    label: `${item.name} · ${scheduleLabel(item)}`,
  }));
  const plan = household.plan === "family_plus" ? "Family Plus" : "Free";

  return (
    <Card title="Household">
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label="Household name"
          value={nameValue}
          error={problems.name}
          onChange={(e) => setName(e.target.value)}
        />
        {incomes.isError && (
          <ErrorBanner title="We couldn’t load your income items." onRetry={() => void incomes.refetch()}>
            Your payday is unchanged.
          </ErrorBanner>
        )}
        <SelectField
          label="Primary income (sets your payday)"
          value={incomeValue}
          options={
            options.length > 0
              ? options
              : [
                  {
                    value: "",
                    label: incomes.isPending
                      ? "Loading…"
                      : incomes.isError
                        ? "Couldn’t load"
                        : "Add an income first",
                  },
                ]
          }
          disabled={options.length === 0}
          onChange={(e) => setIncome(e.target.value)}
        />
        <TextField
          label="Cushion"
          money
          value={cushionValue}
          error={problems.cushion}
          hint="Safe to spend always keeps this much aside."
          onChange={(e) => setCushion(e.target.value)}
        />
        <div className={styles.planRow}>
          <span className={styles.fieldLabel}>Plan</span>
          <div className={styles.planLine}>
            <span>
              <strong>{plan}</strong>
              {billing.data?.interval
                ? ` · billed ${billing.data.interval === "month" ? "monthly" : "yearly"}`
                : ""}
            </span>
            <Link href="/settings/billing" className={styles.link}>
              Billing
            </Link>
          </div>
          {billing.data?.currentPeriodEnd && (
            <span className={styles.hint}>{`${billing.data.cancelAtPeriodEnd ? "Ends" : "Renews"} ${shortDate(
              localDate(billing.data.currentPeriodEnd, household.timezone),
              localDate(billing.data.currentPeriodEnd, household.timezone),
            )}. Covers both of you.`}</span>
          )}
        </div>
        {patch.isError && (
          <ErrorBanner title="We couldn’t save your changes.">
            {problemMessage(patch.error, "Nothing was changed. Try again.")}
          </ErrorBanner>
        )}
        {saved && <StatusBanner>Saved. Your plan is recalculated.</StatusBanner>}
        <div>
          <Button type="submit" disabled={!dirty || patch.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Card>
  );
}
