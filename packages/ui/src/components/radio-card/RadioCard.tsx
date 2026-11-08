// Radio cards, DESIGN_SPEC §4: role="radio" inside role="radiogroup", with the WAI-ARIA radio
// keyboard pattern (one tab stop; arrow keys move and select).
import type { LucideIcon } from "lucide-react";
import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../internal/cx";
import { Icon } from "../internal/Icon";
import styles from "./radio-card.module.css";

export interface RadioCardOption<V extends string> {
  value: V;
  title: string;
  description?: ReactNode;
  /** Optional 40 px leading icon tile. */
  icon?: LucideIcon;
  /** Goal cards: a small uppercase line above the title ("Goal", "Planned expense")... */
  overline?: string;
  /** ...with a value at its right end ("64%"). */
  overlineEnd?: string;
  /** A chip after the title, e.g. "Recommended". */
  badge?: ReactNode;
  /** Extra content under the description (goal cards: progress and status). */
  children?: ReactNode;
  /** Not available yet: a dashed tile that can't be chosen ("Connect a bank · Coming later"). */
  disabled?: boolean;
}

export interface RadioCardGroupProps<V extends string> {
  /** The group's accessible name. */
  label: string;
  options: ReadonlyArray<RadioCardOption<V>>;
  value: V | null;
  onChange: (value: V) => void;
  /** Lay cards out in an auto-fit grid (minimum width in CSS, e.g. goal cards) instead of a column. */
  layout?: "column" | "grid";
  /**
   * Hide the ring indicator. Goal cards select with the 2 px border and tint alone (canvas
   * "Web · Goals"); the radio semantics stay.
   */
  hideIndicator?: boolean;
  /**
   * `goal`: the larger card of "Web · Goals & planned expenses" (radius 3xl, roomier padding, a
   * heading-2 title, the selection drawn as a 2 px border).
   */
  variant?: "default" | "goal";
  className?: string;
}

export function RadioCardGroup<V extends string>({
  label,
  options,
  value,
  onChange,
  layout = "column",
  hideIndicator = false,
  variant = "default",
  className,
}: RadioCardGroupProps<V>) {
  const refs = useRef(new Map<V, HTMLButtonElement>());
  const enabled = options.filter((o) => !o.disabled);
  const tabStop = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: V) {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back) return;
    event.preventDefault();
    const index = enabled.findIndex((o) => o.value === current);
    const next = enabled[(index + (forward ? 1 : -1) + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        styles.group,
        layout === "grid" && styles.grid,
        variant === "goal" && styles.goalGroup,
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              if (el) refs.current.set(option.value, el);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={option.disabled || undefined}
            tabIndex={option.value === tabStop ? 0 : -1}
            className={cx(
              styles.card,
              variant === "goal" && styles.goalCard,
              checked && styles.checked,
              option.disabled && styles.disabled,
            )}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            onKeyDown={(e) => onKeyDown(e, option.value)}
          >
            {!hideIndicator && (
              <span className={styles.ring} aria-hidden="true">
                <span className={styles.dot} />
              </span>
            )}
            {option.icon && (
              <span className={styles.iconTile} aria-hidden="true">
                <Icon icon={option.icon} size={20} />
              </span>
            )}
            <span className={styles.body}>
              {option.overline && (
                <span className={styles.overlineRow}>
                  <span className={styles.overline}>{option.overline}</span>
                  {option.overlineEnd && <span className={styles.overlineEnd}>{option.overlineEnd}</span>}
                </span>
              )}
              <span className={styles.titleRow}>
                <span className={styles.title}>{option.title}</span>
                {option.badge}
              </span>
              {option.description && <span className={styles.description}>{option.description}</span>}
              {option.children}
            </span>
          </button>
        );
      })}
    </div>
  );
}
