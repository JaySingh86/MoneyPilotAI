// KPI tile, DESIGN_SPEC §4: label, amount-l value, caption, optional owner split bar.
import { money } from "@mp/format";
import type { HeadlineRounding } from "@mp/format";
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import type { Density, OwnerRole } from "../internal/types";
import styles from "./kpi-tile.module.css";

export type KpiValue =
  /** Money in cents. Tiles use whole dollars (`headline`); bill totals keep cents (`detail`). */
  | { cents: number; mode?: "headline" | "detail"; rounding?: HeadlineRounding }
  /** A non-money figure already computed by the API, e.g. "92%" or "2". */
  | { text: string };

/**
 * Value color: `income` (income.text), `attention` (price increases), `brand` (could save,
 * automation), `info` (estimates to confirm).
 */
export type KpiTone = "default" | "income" | "attention" | "brand" | "info";

export interface OwnerSplitSegment {
  role: OwnerRole;
  name: string;
  cents: number;
}

export interface KpiTileProps {
  label: string;
  value: KpiValue;
  tone?: KpiTone;
  caption?: ReactNode;
  /** Owner split bar (height 8) with a legend of names and amounts. */
  split?: readonly OwnerSplitSegment[];
  density?: Density;
  className?: string;
}

function formatValue(value: KpiValue): string {
  if ("text" in value) return value.text;
  if (value.mode === "detail") return money(value.cents, { mode: "detail" });
  return money(value.cents, { mode: "headline", rounding: value.rounding ?? "floor" });
}

export function KpiTile({
  label,
  value,
  tone = "default",
  caption,
  split,
  density = "web",
  className,
}: KpiTileProps) {
  const total = split?.reduce((sum, s) => sum + Math.max(0, s.cents), 0) ?? 0;
  return (
    <div className={cx(styles.tile, density === "mobile" && styles.mobile, className)}>
      <p className={styles.label}>{label}</p>
      <p className={cx(styles.value, styles[tone])}>{formatValue(value)}</p>
      {caption && <p className={styles.caption}>{caption}</p>}
      {split && split.length > 0 && (
        <div className={styles.split}>
          <div className={styles.splitBar} aria-hidden="true">
            {split.map((s) => (
              <span
                key={`${s.role}-${s.name}`}
                className={cx(styles.segment, styles[s.role])}
                style={{
                  width: total > 0 ? `${Number(((Math.max(0, s.cents) / total) * 100).toFixed(4))}%` : "0%",
                }}
              />
            ))}
          </div>
          <ul className={styles.legend}>
            {split.map((s) => (
              <li key={`${s.role}-${s.name}`}>
                <span>{s.name}</span>
                <span className={styles.legendAmount}>{money(s.cents, { mode: "detail" })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
