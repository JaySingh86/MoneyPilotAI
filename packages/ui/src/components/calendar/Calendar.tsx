// Calendar cell and event chip, DESIGN_SPEC §4.2.
import { money } from "@mp/format";
import { useId } from "react";
import type { ButtonHTMLAttributes } from "react";
import { OwnerDot } from "../avatar/Avatar";
import { cx } from "../internal/cx";
import { VisuallyHidden } from "../internal/VisuallyHidden";
import type { CalendarDate } from "../internal/types";
import type { OwnerRole } from "../internal/types";
import styles from "./calendar.module.css";

/** income · bill · estimate (dashed) · decision (attention) · planned (outline). */
export type EventChipKind = "income" | "bill" | "estimate" | "decision" | "planned";

export interface EventChipProps {
  kind: EventChipKind;
  owner: OwnerRole;
  name: string;
  /** Signed cents: income positive, outflows negative. */
  amountCents: number;
}

/** Calendar event chip: owner dot, name (ellipsis), signed amount (600). */
export function EventChip({ kind, owner, name, amountCents }: EventChipProps) {
  const amount = money(amountCents, { mode: "chip" });
  return (
    <span className={cx(styles.chip, styles[kind])} data-kind={kind}>
      <OwnerDot role={owner} />
      <span className={styles.chipName}>{name}</span>
      <VisuallyHidden> </VisuallyHidden>
      <span className={styles.chipAmount}>{kind === "estimate" ? `~${amount}` : amount}</span>
    </span>
  );
}

const MAX_CHIPS = 3;

export interface CalendarCellProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onSelect" | "children"
> {
  date: CalendarDate;
  events: readonly EventChipProps[];
  selected?: boolean;
  /** brand.tint background and a "PAYDAY" label. */
  payday?: boolean;
  /** Days outside the month use bg.muted / text.disabled and can't be selected. */
  outsideMonth?: boolean;
  onSelect?: (date: CalendarDate) => void;
}

function itemCount(n: number): string {
  if (n === 0) return "no items";
  return n === 1 ? "1 item" : `${n} items`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * A day cell: a button, min-height 112. Selection is `aria-pressed`. The name comes from the
 * visible content plus visually hidden words ("November 4, payday, Car insurance −$684"), so it
 * always contains what is drawn (WCAG 2.5.3, Q-049); the item count is its description.
 */
export function CalendarCell({
  date,
  events,
  selected = false,
  payday = false,
  outsideMonth = false,
  onSelect,
  className,
  ...rest
}: CalendarCellProps) {
  const countId = useId();
  const shown = outsideMonth ? [] : events.slice(0, MAX_CHIPS);
  const more = outsideMonth ? 0 : events.length - shown.length;
  const showsPayday = payday && !outsideMonth;
  return (
    <button
      type="button"
      aria-pressed={outsideMonth ? undefined : selected}
      aria-describedby={outsideMonth ? undefined : countId}
      disabled={outsideMonth}
      className={cx(
        styles.cell,
        showsPayday && styles.payday,
        selected && !outsideMonth && styles.selected,
        outsideMonth && styles.outside,
        className,
      )}
      onClick={() => onSelect?.(date)}
      {...rest}
    >
      <span className={styles.cellHead}>
        <span className={styles.dayNumber}>
          <VisuallyHidden>{`${MONTHS[date.month - 1]} `}</VisuallyHidden>
          {date.day}
        </span>
        {showsPayday && (
          <>
            <VisuallyHidden>, </VisuallyHidden>
            <span className={styles.paydayLabel}>payday</span>
          </>
        )}
      </span>
      {shown.map((event, i) => (
        <span key={`${event.name}-${i}`} className={styles.chipSlot}>
          <VisuallyHidden>, </VisuallyHidden>
          <EventChip {...event} />
        </span>
      ))}
      {more > 0 && (
        <span className={styles.chipSlot}>
          <VisuallyHidden>, </VisuallyHidden>
          <span className={styles.more}>{`+${more} more`}</span>
        </span>
      )}
      {!outsideMonth && (
        <span id={countId} hidden>
          {itemCount(events.length)}
        </span>
      )}
    </button>
  );
}
