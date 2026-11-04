"use client";

import { money, shortfall } from "@mp/format";
import { Button, Card, StatusChip } from "@mp/ui";
import type { OptionResult, PlanResponse, ShortfallOption } from "../../../lib/api/planning-types";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { monthYear, shortDate } from "../../../lib/format/dates";
import type { Owners } from "../../../lib/owners";
import styles from "./overview.module.css";

const dollars = (cents: number) => money(cents, { mode: "headline", rounding: "nearest" });

/** The effect chip: ok when safe to spend ends up at or above $0, info otherwise (§5.3). */
function effectText(result: OptionResult): string {
  if (result.safeToSpendDisplayCents !== null) {
    return `${money(result.safeToSpendDisplayCents, { mode: "headline" })} safe to spend`;
  }
  const gap = `${shortfall(result.safeToSpendCents)}`;
  return result.neverBelowZero ? `${gap}, never below $0` : gap;
}

/** "Car insurance renewal" → "car insurance renewal" (keeps names like "iPhone plan" alone). */
function lowerFirst(name: string): string {
  return /^[A-Z][a-z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

/** The name of an item or planned expense, from the rows of the window. */
function nameOf(plan: PlanResponse, sourceId: string): string {
  return plan.dueBeforePayday.find((r) => r.sourceId === sourceId)?.name ?? "this expense";
}

function describe(option: ShortfallOption, plan: PlanResponse): { title: string; meta: string } {
  switch (option.kind) {
    case "move_from_emergency_fund": {
      const fund = plan.goals.find((g) => g.id === option.goalId);
      const reach =
        option.reachMonthBefore && option.reachMonthAfter && fund
          ? ` Reaching ${dollars(fund.targetCents)} moves from ${monthYear(option.reachMonthBefore)} to ${monthYear(option.reachMonthAfter)}.`
          : "";
      return {
        title: `Move ${dollars(option.amountCents)} from the ${fund?.name ?? "Emergency fund"}`,
        meta: `The fund drops to ${dollars(option.fundBalanceAfterCents)}.${reach}`,
      };
    }
    case "split_expense":
      return {
        title: `Split ${lowerFirst(nameOf(plan, option.plannedExpenseId))}: ${dollars(option.amountNowCents)} now, ${dollars(option.amountAfterPaydayCents)} after ${shortDate(plan.window.to, plan.asOf)}`,
        meta: "Only if the payee allows it",
      };
    case "move_bill_to_payday":
      return {
        title: `Pay ${lowerFirst(nameOf(plan, option.itemId))} on ${shortDate(option.toDate, plan.asOf)} instead of ${shortDate(option.fromDate, plan.asOf)}`,
        meta:
          option.itemKind === "insurance"
            ? "Only if your insurer allows it"
            : "Only if your provider allows it",
      };
  }
}

export function CoverTheGap({ plan, owners }: { plan: PlanResponse; owners: Owners }) {
  const { me } = useAuth();
  const partner = owners.members.find((m) => m.id !== me?.id);
  return (
    <div id="cover-the-gap">
      <Card
        title="Ways to cover the gap"
        subtitle="Each option is recalculated by MoneyPilot’s rules. You choose. Nothing moves automatically."
      >
        <ul className={styles.options}>
          {plan.shortfallOptions.map((option) => {
            const { title, meta } = describe(option, plan);
            return (
              <li key={option.kind} className={styles.option}>
                <div className={styles.optionText}>
                  <p className={styles.optionTitle}>{title}</p>
                  <p className={styles.optionMeta}>{meta}</p>
                </div>
                <StatusChip variant={option.result.effect}>{effectText(option.result)}</StatusChip>
              </li>
            );
          })}
        </ul>
        <div className={styles.actions}>
          <Button disabled aria-describedby="approvals-note">
            {partner ? `Decide with ${partner.name}` : "Decide together"}
          </Button>
        </div>
        <p id="approvals-note" className={styles.actionNote}>
          Asking {partner?.name ?? "your partner"} to approve a change arrives with shared decisions. Until
          then, each option shows what it would do.
        </p>
      </Card>
    </div>
  );
}
