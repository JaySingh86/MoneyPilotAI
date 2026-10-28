// Mobile list row, DESIGN_SPEC §4: the whole row is the link.
import { weekday } from "@mp/format";
import type { MoneyMode } from "@mp/format";
import type { ReactNode } from "react";
import { Amount } from "../amount/Amount";
import { cx } from "../internal/cx";
import type { CalendarDate } from "../internal/types";
import type { LinkComponent } from "../navigation/Navigation";
import styles from "./list-row.module.css";

export interface ListRowProps {
  href: string;
  title: string;
  /** 12 px muted meta line. */
  meta?: ReactNode;
  /** Date block, 40 wide: 11 px muted weekday over the 700 day. */
  date?: CalendarDate;
  amountCents?: number;
  amountMode?: MoneyMode;
  /** A chip or other trailing content under the amount. */
  trailing?: ReactNode;
  linkComponent?: LinkComponent;
  className?: string;
}

/** One row inside a `ListRows` list. */
export function ListRow({
  href,
  title,
  meta,
  date,
  amountCents,
  amountMode = "detail",
  trailing,
  linkComponent,
  className,
}: ListRowProps) {
  const Link = linkComponent ?? "a";
  return (
    <li className={cx(styles.item, className)}>
      <Link href={href} className={styles.row}>
        {date && (
          <span className={styles.dateBlock}>
            <span className={styles.weekday}>{weekday(date)}</span>
            <span className={styles.day}>{date.day}</span>
          </span>
        )}
        <span className={styles.body}>
          <span className={styles.title}>{title}</span>
          {meta && <span className={styles.meta}>{meta}</span>}
        </span>
        {(amountCents !== undefined || trailing) && (
          <span className={styles.end}>
            {amountCents !== undefined && <Amount cents={amountCents} mode={amountMode} strong />}
            {trailing}
          </span>
        )}
      </Link>
    </li>
  );
}

/** The list around `ListRow`s, with border.divider between rows. */
export function ListRows({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul aria-label={label} className={cx(styles.list, className)}>
      {children}
    </ul>
  );
}
