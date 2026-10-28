// Table, DESIGN_SPEC §4. Wide tables scroll inside their wrapper (min-width 640, §3.1).
import { money } from "@mp/format";
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import shared from "../internal/shared.module.css";
import styles from "./table.module.css";

export interface TableColumn<R> {
  key: string;
  header: string;
  /** Amount columns align to the end. */
  align?: "start" | "end";
  render: (row: R) => ReactNode;
  /** This column's cell is the row header (usually the name). */
  rowHeader?: boolean;
}

export interface TableTotal {
  label: string;
  cents: number;
}

export interface TableProps<R> {
  /** Names the table for screen readers. Hidden unless `showCaption`. */
  caption: string;
  showCaption?: boolean;
  columns: ReadonlyArray<TableColumn<R>>;
  rows: readonly R[];
  rowKey: (row: R) => string;
  /** The row shown in the detail aside: brand.tint. Mark the row's name button with aria-pressed. */
  selectedKey?: string;
  /** 10 px cell padding instead of 12. */
  dense?: boolean;
  /** Footer total, Manrope 800 16, under the last column. */
  total?: TableTotal;
  /** Shown in place of the rows when there are none (use `EmptyState`). */
  empty?: ReactNode;
  className?: string;
}

export function Table<R>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  selectedKey,
  dense = false,
  total,
  empty,
  className,
}: TableProps<R>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className={cx(styles.wrapper, className)}>
      <table className={cx(styles.table, dense && styles.dense)}>
        <caption className={showCaption ? styles.caption : shared.visuallyHidden}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className={cx(styles.th, col.align === "end" && styles.end)}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr key={key} className={cx(styles.row, key === selectedKey && styles.selected)}>
                {columns.map((col) => {
                  const Cell = col.rowHeader ? "th" : "td";
                  return (
                    <Cell
                      key={col.key}
                      scope={col.rowHeader ? "row" : undefined}
                      className={cx(
                        styles.td,
                        col.align === "end" && styles.end,
                        col.align === "end" && styles.amount,
                      )}
                    >
                      {col.render(row)}
                    </Cell>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {total && (
          <tfoot>
            <tr>
              <th
                scope="row"
                colSpan={Math.max(1, columns.length - 1)}
                className={cx(styles.td, styles.totalLabel)}
              >
                {total.label}
              </th>
              <td className={cx(styles.td, styles.end, styles.total)}>
                {money(total.cents, { mode: "detail" })}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** A two-line cell: 600 title over 12 px muted meta. */
export function TwoLineCell({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <span className={styles.twoLine}>
      <span className={styles.cellTitle}>{title}</span>
      {meta && <span className={styles.cellMeta}>{meta}</span>}
    </span>
  );
}
