"use client";

import { money } from "@mp/format";
import { HeroCard, KpiTile } from "@mp/ui";
import type { OwnerSplitSegment } from "@mp/ui";
import type { DueRowDto, PlanResponse } from "../../../lib/api/planning-types";
import { shortDate } from "../../../lib/format/dates";
import { shortfallCaption } from "../../../lib/format/text";
import type { Owners } from "../../../lib/owners";
import styles from "./overview.module.css";

/** "Lowest projected balance $1,507 on Nov 5 − Cushion $500 = $1,007" with a "See the math" link. */
function Breakdown({ plan, onMath }: { plan: PlanResponse; onMath: () => void }) {
  return (
    <>
      <span>
        Lowest projected balance <strong>{money(plan.lowest.balanceCents, { mode: "headline" })}</strong> on{" "}
        {shortDate(plan.lowest.date, plan.asOf)}
      </span>
      <span aria-hidden="true">−</span>
      <span>
        Cushion <strong>{money(plan.cushionCents, { mode: "headline" })}</strong>
      </span>
      <span aria-hidden="true">=</span>
      <strong>{money(plan.safeToSpendCents, { mode: "headline" })}</strong>
      <button type="button" className={styles.linkButton} onClick={onMath}>
        See the math
      </button>
    </>
  );
}

export function Hero({ plan, onMath }: { plan: PlanResponse; onMath: () => void }) {
  const payday = shortDate(plan.window.to, plan.asOf, { weekday: true });
  if (plan.state === "shortfall") {
    return (
      <HeroCard
        variant="shortfall"
        paydayLabel={payday}
        amountCents={plan.safeToSpendCents}
        caption={shortfallCaption(plan)}
        breakdown={<Breakdown plan={plan} onMath={onMath} />}
      />
    );
  }
  const perDay = plan.perDayCents;
  return (
    <HeroCard
      label={`Safe to spend until ${payday}`}
      amountCents={plan.safeToSpendCents}
      status={
        perDay === null
          ? undefined
          : `≈ ${money(perDay, { mode: "headline" })} a day for ${plan.window.daysToPayday} days`
      }
      breakdown={<Breakdown plan={plan} onMath={onMath} />}
    />
  );
}

function ownedCounts(rows: readonly DueRowDto[], owners: Owners): string {
  const parts: string[] = [];
  for (const m of owners.members) {
    const n = rows.filter((r) => r.owner === m.id).length;
    if (n > 0) parts.push(`${m.name} owns ${n}`);
  }
  const shared = rows.filter((r) => owners.member(r.owner) === null).length;
  if (shared > 0) parts.push(`Both own ${shared}`);
  return parts.join(", ");
}

export function BillsTile({ plan, owners }: { plan: PlanResponse; owners: Owners }) {
  const { billsBeforePayday: bills, dueBeforePayday: rows } = plan;
  const noun = rows.every((r) => r.kind === "bill") ? "bill" : "item";
  const split: OwnerSplitSegment[] = [];
  for (const m of owners.members) {
    const cents = bills.byOwner[m.id];
    if (cents) split.push({ role: m.role, name: m.name, cents });
  }
  const shared = Object.entries(bills.byOwner)
    .filter(([id]) => owners.member(id) === null)
    .reduce((sum, [, cents]) => sum + cents, 0);
  if (shared > 0) split.push({ role: "both", name: "Both", cents: shared });
  return (
    <KpiTile
      label="Bills before payday"
      value={{ cents: bills.totalCents, mode: "detail" }}
      caption={
        bills.count === 0
          ? "Nothing due before payday"
          : `${bills.count} ${noun}${bills.count === 1 ? "" : "s"} · ${ownedCounts(rows, owners)}`
      }
      split={split.length > 0 ? split : undefined}
    />
  );
}

export function IncomeTile({ plan, owners }: { plan: PlanResponse; owners: Owners }) {
  const incomes = plan.runway.flatMap((d) => d.events).filter((e) => e.kind === "income");
  const [first, second] = incomes;
  if (!first) {
    return (
      <KpiTile
        label="Income expected"
        value={{ cents: 0, mode: "detail" }}
        caption="No paycheck before payday"
      />
    );
  }
  // Goal transfers on the final payday belong to the next window (rule 2): the contract's runwayDetail.
  const goals = plan.runwayDetail.excludedEvents
    .filter((e) => e.kind === "goal_transfer")
    .reduce((sum, e) => sum - e.amountCents, 0);
  const paycheck = (owner: string) => `${owners.label(owner)}’s paycheck`;
  const footnote = second
    ? `Next: ${paycheck(second.owner)} ${money(second.amountCents, { mode: "headline", rounding: "nearest" })} on ${shortDate(second.date, plan.asOf)}${goals > 0 ? `, then ${money(goals, { mode: "headline", rounding: "nearest" })} to goals` : ""}`
    : undefined;
  return (
    <KpiTile
      label="Income expected"
      value={{ cents: first.amountCents, mode: "detail" }}
      caption={`${shortDate(first.date, plan.asOf, { weekday: true })} · ${paycheck(first.owner)}`}
      footnote={footnote}
    />
  );
}
