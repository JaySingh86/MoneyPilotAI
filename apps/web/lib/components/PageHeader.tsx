import type { ReactNode } from "react";
import styles from "./page-header.module.css";

export interface PageHeaderProps {
  /** Date or section: 12/600 uppercase. */
  overline?: string;
  title: string;
  subtitle?: string;
  /** Right side; wraps below on narrow widths. */
  actions?: ReactNode;
}

/** Page header, DESIGN_SPEC §3.1: overline, `heading-1` title, `body-l` subtitle, actions on the right. */
export function PageHeader({ overline, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.text}>
        {overline && <p className={styles.overline}>{overline}</p>}
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
