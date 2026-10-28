// Filter pills, DESIGN_SPEC §4: a labelled group of toggle buttons with optional counts.
import { cx } from "../internal/cx";
import styles from "./filter-pills.module.css";

export interface FilterPillOption<V extends string> {
  value: V;
  label: string;
  /** Item count from the API, shown after the label at 75% opacity. */
  count?: number;
}

export interface FilterPillsProps<V extends string> {
  /** The group's accessible name, e.g. "Category". */
  label: string;
  options: ReadonlyArray<FilterPillOption<V>>;
  value: V;
  onChange: (value: V) => void;
  className?: string;
}

export function FilterPills<V extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: FilterPillsProps<V>) {
  return (
    <div role="group" aria-label={label} className={cx(styles.group, className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            className={cx(styles.pill, selected && styles.selected)}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
