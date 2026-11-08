// Progress bar, DESIGN_SPEC §4: label row above, track, caption row below.
import { useId } from "react";
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import styles from "./progress-bar.module.css";

/** Fill by goal order: 1st brand.default, 2nd partnerA.mark, 3rd partnerB.mark. */
export type ProgressTone = "brand" | "partnerA" | "partnerB";

export interface ProgressBarProps {
  title: string;
  /** Whole-number percent from the API (engine). */
  percent: number;
  tone?: ProgressTone;
  /** 12 px muted line under the bar, e.g. "$6,400 of $10,000". */
  caption?: ReactNode;
  /**
   * `bare` draws only the track and the caption: the title names the progressbar for screen readers and
   * the percent is written elsewhere (goal cards put it in their overline).
   */
  variant?: "labeled" | "bare";
  className?: string;
}

export function ProgressBar({
  title,
  percent,
  tone = "brand",
  caption,
  variant = "labeled",
  className,
}: ProgressBarProps) {
  const id = useId();
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={cx(styles.progress, className)}>
      {variant === "labeled" && (
        <div className={styles.labelRow}>
          <span id={id} className={styles.title}>
            {title}
          </span>
          <span className={styles.percent} aria-hidden="true">
            {`${percent}%`}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        {...(variant === "labeled" ? { "aria-labelledby": id } : { "aria-label": title })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-valuetext={`${percent}%`}
        className={styles.track}
      >
        <span className={cx(styles.fill, styles[tone])} style={{ width: `${clamped}%` }} />
      </div>
      {caption && <p className={styles.caption}>{caption}</p>}
    </div>
  );
}
