// Math breakdown, DESIGN_SPEC §4: "THE MATH" overline, then label/value rows from the engine.
import { money } from "@mp/format";
import type { HeadlineRounding, MoneyMode } from "@mp/format";
import { useId } from "react";
import { cx } from "../internal/cx";
import styles from "./math-breakdown.module.css";

export interface MathRow {
  label: string;
  cents: number;
  mode?: MoneyMode;
  rounding?: HeadlineRounding;
  /** `total`: 600 with a top rule. `gap`: 700 attention.text (a shortfall to decide on). */
  kind?: "total" | "gap";
}

export interface MathBreakdownProps {
  rows: readonly MathRow[];
  /** The overline; "The math" by default (drawn uppercase). */
  title?: string;
  className?: string;
}

function format(row: MathRow): string {
  if (row.mode === "headline")
    return money(row.cents, { mode: "headline", rounding: row.rounding ?? "floor" });
  return money(row.cents, { mode: row.mode ?? "detail" });
}

export function MathBreakdown({ rows, title = "The math", className }: MathBreakdownProps) {
  const id = useId();
  return (
    <div className={cx(styles.math, className)}>
      <p id={id} className={styles.overline}>
        {title}
      </p>
      <dl aria-labelledby={id} className={styles.rows}>
        {rows.map((row) => (
          <div
            key={row.label}
            className={cx(styles.row, row.kind === "total" && styles.total, row.kind === "gap" && styles.gap)}
          >
            <dt>{row.label}</dt>
            <dd>{format(row)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
