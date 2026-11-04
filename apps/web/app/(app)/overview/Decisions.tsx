"use client";

import { AttentionCard, Button, Card, EmptyState, StatusChip } from "@mp/ui";
import { Info } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Decision, DecisionKind, PlanResponse } from "../../../lib/api/planning-types";
import { count } from "../../../lib/format/text";
import { fillTemplate } from "../../../lib/format/templates";
import type { Owners } from "../../../lib/owners";
import styles from "./overview.module.css";

const KIND_LABEL: Record<DecisionKind, string> = {
  shortfall: "Needs a decision",
  not_usual_month: "Not in your usual month",
  estimate: "Estimate",
  decide_by: "Decide by",
  goal_behind: "Goal check",
};

export type DrawerFocus = { kind: "math" } | { kind: "what-if"; decision: Decision };

/** A "Decide this week" card that is not the first (the first is the attention variant). */
function SuggestionCard({
  label,
  tone,
  title,
  children,
  action,
}: {
  label: string;
  tone: "neutral" | "brand";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className={styles.suggestion}>
      <p className={`${styles.suggestionLabel} ${tone === "brand" ? styles.suggestionLabelBrand : ""}`}>
        {label}
      </p>
      <h3 className={styles.suggestionTitle}>{title}</h3>
      <p className={styles.suggestionBody}>{children}</p>
      {action && <div className={styles.actions}>{action}</div>}
    </article>
  );
}

/** Whether the "pay on payday instead" what-if exists for this card (rule 9: only when it changes safe to spend). */
function hasWhatIf(d: Decision): boolean {
  return d.kind === "not_usual_month" && d.params.altDate != null && d.params.altSafeToSpendCents != null;
}

function CardActions({
  decision,
  onOpen,
  compact,
}: {
  decision: Decision;
  onOpen: (focus: DrawerFocus) => void;
  compact: boolean;
}) {
  const size = compact ? "compact" : undefined;
  switch (decision.kind) {
    case "not_usual_month":
      return (
        <>
          {hasWhatIf(decision) && (
            <Button size={size} onClick={() => onOpen({ kind: "what-if", decision })}>
              Plan for it
            </Button>
          )}
          <Button variant="secondary" size={size} onClick={() => onOpen({ kind: "math" })}>
            How was this calculated?
          </Button>
        </>
      );
    case "shortfall":
      return (
        <>
          <Button size={size} onClick={() => document.getElementById("cover-the-gap")?.scrollIntoView()}>
            See ways to cover the gap
          </Button>
          <Button variant="secondary" size={size} onClick={() => onOpen({ kind: "math" })}>
            How was this calculated?
          </Button>
        </>
      );
    case "estimate":
      return <Link href="/bills">Enter actual amount</Link>;
    case "goal_behind":
      return <Link href="/goals">Compare options</Link>;
    case "decide_by":
      return <Link href="/renewals">Open renewals</Link>;
  }
}

export function Decisions({
  plan,
  owners,
  onOpen,
}: {
  plan: PlanResponse;
  owners: Owners;
  onOpen: (focus: DrawerFocus) => void;
}) {
  const [first, ...rest] = plan.decisions;
  const text = (d: Decision) => ({
    title: fillTemplate(d.templateText, d.params, plan.asOf),
    body: fillTemplate(d.detailTemplateText, d.params, plan.asOf),
    label: `${KIND_LABEL[d.kind]} · ${owners.label(d.owner)}`,
  });
  return (
    <Card
      title="Decide this week"
      actions={
        plan.decisions.length > 0 ? (
          <StatusChip variant="ok">{count(plan.decisions.length, "item")}</StatusChip>
        ) : undefined
      }
    >
      <div className={styles.stack}>
        {!first && (
          <EmptyState>All caught up. New bills and renewals will appear here as they arrive.</EmptyState>
        )}
        {first && (
          <AttentionCard
            label={text(first).label}
            title={text(first).title}
            actions={<CardActions decision={first} onOpen={onOpen} compact />}
          >
            {text(first).body}
          </AttentionCard>
        )}
        {rest.map((d) => (
          <SuggestionCard
            key={d.id}
            label={text(d).label}
            tone={d.kind === "goal_behind" ? "brand" : "neutral"}
            title={text(d).title}
            action={<CardActions decision={d} onOpen={onOpen} compact />}
          >
            {text(d).body}
          </SuggestionCard>
        ))}
        <p className={styles.footnote}>
          <Info size={16} aria-hidden="true" className={styles.footnoteIcon} />
          <span>
            Amounts come from MoneyPilot’s calculation rules. AI only writes the explanations, and nothing
            moves money.
          </span>
        </p>
      </div>
    </Card>
  );
}
