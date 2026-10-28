// A money amount: cents in, §7 text out, tabular figures. Income ("+") renders in income.text.
import { money } from "@mp/format";
import type { HeadlineRounding, MoneyMode } from "@mp/format";
import { cx } from "../internal/cx";
import styles from "./amount.module.css";

export interface AmountProps {
  cents: number;
  /** `detail` in tables and lists; `signed` in mixed lists; `chip`; `estimate`; `headline`. */
  mode?: MoneyMode;
  rounding?: HeadlineRounding;
  /** 600 weight (table and list amounts). */
  strong?: boolean;
  className?: string;
}

export function Amount({ cents, mode = "detail", rounding, strong = false, className }: AmountProps) {
  const text =
    mode === "headline" ? money(cents, { mode, rounding: rounding ?? "floor" }) : money(cents, { mode });
  const income = (mode === "signed" || mode === "chip") && cents > 0;
  return (
    <span className={cx(styles.amount, strong && styles.strong, income && styles.income, className)}>
      {text}
    </span>
  );
}
