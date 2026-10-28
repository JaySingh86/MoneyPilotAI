// Status chip and nav badge, DESIGN_SPEC §4. Chips always carry text (§1 rule 6).
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import shared from "../internal/shared.module.css";
import styles from "./status-chip.module.css";

/**
 * - `ok`: confirmed, on track. `income`: paychecks, expected income.
 * - `attention`: needs a decision only (§1 rule 4). `info`: neutral facts.
 * - `estimate`: any amount not yet confirmed (dashed). `release`: plan documents only.
 */
export type StatusChipVariant = "ok" | "income" | "attention" | "info" | "estimate" | "release";

export interface StatusChipProps {
  variant: StatusChipVariant;
  children: ReactNode;
  className?: string;
}

export function StatusChip({ variant, children, className }: StatusChipProps) {
  return <span className={cx(styles.chip, styles[variant], className)}>{children}</span>;
}

export interface BadgeProps {
  /** The count, e.g. open review items. */
  count: number;
  /** What the count means for screen readers: "4 to review". Defaults to the number. */
  label?: string;
  className?: string;
}

/** The nav count badge: 12/600, padding 1×8, attention variant. */
export function Badge({ count, label, className }: BadgeProps) {
  return (
    <span className={cx(styles.badge, className)}>
      <span aria-hidden={label ? true : undefined}>{count}</span>
      {label && <span className={shared.visuallyHidden}>{label}</span>}
    </span>
  );
}
