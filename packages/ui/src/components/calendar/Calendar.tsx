// Calendar cell and event chip, DESIGN_SPEC §4.2.
import { date as formatDate, money } from "@mp/format";
import type { ButtonHTMLAttributes } from "react";
import { OwnerDot } from "../avatar/Avatar";
import { cx } from "../internal/cx";
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

/** A day cell: a button, min-height 112. Selection is `aria-pressed`. */
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
  const shown = outsideMonth ? [] : events.slice(0, MAX_CHIPS);
  const more = outsideMonth ? 0 : events.length - shown.length;
  const label = outsideMonth
    ? formatDate(date, { relativeTo: date, month: "long" })
    : [
        formatDate(date, { relativeTo: date, month: "long" }),
        payday ? "payday" : null,
        itemCount(events.length),
      ]
        .filter(Boolean)
        .join(", ");
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={outsideMonth ? undefined : selected}
      disabled={outsideMonth}
      className={cx(
        styles.cell,
        payday && !outsideMonth && styles.payday,
        selected && !outsideMonth && styles.selected,
        outsideMonth && styles.outside,
        className,
      )}
      onClick={() => onSelect?.(date)}
      {...rest}
    >
      <span className={styles.cellHead}>
        <span className={styles.dayNumber}>{date.day}</span>
        {payday && !outsideMonth && <span className={styles.paydayLabel}>Payday</span>}
      </span>
      {shown.map((event, i) => (
        <EventChip key={`${event.name}-${i}`} {...event} />
      ))}
      {more > 0 && <span className={styles.more}>{`+${more} more`}</span>}
    </button>
  );
}
