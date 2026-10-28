// Stepper, DESIGN_SPEC §4: two 44 × 44 secondary buttons around an <output aria-live="polite">.
import { money } from "@mp/format";
import { Minus, Plus } from "lucide-react";
import { useId } from "react";
import { Icon } from "../internal/Icon";
import { cx } from "../internal/cx";
import styles from "./stepper.module.css";

export interface StepperProps {
  /** Shown above and linked with aria-labelledby, e.g. "Monthly deposit". */
  label: string;
  valueCents: number;
  /** Called with the proposed new amount; the plan recalculates through the API. */
  onChange: (valueCents: number) => void;
  /** Step $25 by default. */
  stepCents?: number;
  /** Minimum $0 by default. */
  minCents?: number;
  maxCents?: number;
  className?: string;
}

export function Stepper({
  label,
  valueCents,
  onChange,
  stepCents = 2500,
  minCents = 0,
  maxCents,
  className,
}: StepperProps) {
  const labelId = useId();
  const outputId = useId();
  const step = money(stepCents, { mode: "headline", rounding: "nearest" });
  const canDecrease = valueCents - stepCents >= minCents;
  const canIncrease = maxCents === undefined || valueCents + stepCents <= maxCents;

  return (
    <div className={cx(styles.stepper, className)} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.step}
          aria-label={`Decrease by ${step}`}
          aria-controls={outputId}
          aria-disabled={!canDecrease || undefined}
          onClick={() => {
            if (canDecrease) onChange(valueCents - stepCents);
          }}
        >
          <Icon icon={Minus} size={20} />
        </button>
        <output id={outputId} aria-live="polite" aria-labelledby={labelId} className={styles.value}>
          {money(valueCents, { mode: "headline", rounding: "nearest" })}
        </output>
        <button
          type="button"
          className={styles.step}
          aria-label={`Increase by ${step}`}
          aria-controls={outputId}
          aria-disabled={!canIncrease || undefined}
          onClick={() => {
            if (canIncrease) onChange(valueCents + stepCents);
          }}
        >
          <Icon icon={Plus} size={20} />
        </button>
      </div>
    </div>
  );
}
