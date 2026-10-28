// Segmented control, DESIGN_SPEC §4: aria-pressed on each segment, aria-label on the group.
import type { Density } from "../internal/types";
import { cx } from "../internal/cx";
import styles from "./segmented-control.module.css";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string> {
  /** The group's accessible name, e.g. "Show bills for". */
  label: string;
  options: ReadonlyArray<SegmentOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Use `bg.track` for the track when the control sits directly on the canvas. */
  onCanvas?: boolean;
  /** Mobile: radius lg track and equal-width segments. */
  density?: Density;
  className?: string;
}

export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onChange,
  onCanvas = false,
  density = "web",
  className,
}: SegmentedControlProps<V>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx(
        styles.track,
        onCanvas && styles.onCanvas,
        density === "mobile" && styles.mobile,
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            className={cx(styles.segment, selected && styles.selected)}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
