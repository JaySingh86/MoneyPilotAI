// Sidebar nav (web) and tab bar (mobile web preview), DESIGN_SPEC §3 and §4.
import type { LucideIcon } from "lucide-react";
import { useId } from "react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { cx } from "../internal/cx";
import { Icon } from "../internal/Icon";
import { Badge } from "../status-chip/StatusChip";
import styles from "./navigation.module.css";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The current page: `aria-current="page"`. */
  current?: boolean;
  /** Optional count badge, e.g. open review items. */
  count?: number;
  /** Screen-reader text for the count, e.g. "4 to review". */
  countLabel?: string;
}

export interface NavGroup {
  /** 11/600 uppercase group label. */
  label?: string;
  items: readonly NavItem[];
}

/** Lets apps/web pass `next/link`. Receives the anchor props. */
export type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

export interface SidebarNavProps {
  /** The nav landmark's name. */
  label?: string;
  groups: readonly NavGroup[];
  /** Logo and household switcher above the groups. */
  header?: ReactNode;
  footer?: ReactNode;
  linkComponent?: LinkComponent;
  className?: string;
}

function DefaultLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} />;
}

export function SidebarNav({
  label = "Main",
  groups,
  header,
  footer,
  linkComponent: Link = DefaultLink,
  className,
}: SidebarNavProps) {
  const baseId = useId();
  return (
    <nav aria-label={label} className={cx(styles.sidebar, className)}>
      {header}
      {groups.map((group, gi) => (
        <div key={group.label ?? gi} className={styles.group}>
          {group.label && (
            <p className={styles.groupLabel} id={`${baseId}-group-${gi}`}>
              {group.label}
            </p>
          )}
          <ul className={styles.list} aria-labelledby={group.label ? `${baseId}-group-${gi}` : undefined}>
            {group.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.current ? "page" : undefined}
                  className={cx(styles.item, item.current && styles.current)}
                >
                  <Icon icon={item.icon} size={18} />
                  <span className={styles.itemLabel}>{item.label}</span>
                  {item.count !== undefined && item.count > 0 && (
                    <Badge count={item.count} label={item.countLabel} className={styles.badge} />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {footer}
    </nav>
  );
}

export interface TabBarProps {
  /** Five tabs in this order: Today, Calendar, Ask, Renewals, Household (§3.2). */
  items: readonly NavItem[];
  label?: string;
  linkComponent?: LinkComponent;
  className?: string;
}

export function TabBar({ items, label = "Main", linkComponent: Link = DefaultLink, className }: TabBarProps) {
  return (
    <nav aria-label={label} className={cx(styles.tabBar, className)}>
      <ul className={styles.tabs}>
        {items.map((item) => (
          <li key={item.href} className={styles.tabItem}>
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={cx(styles.tab, item.current && styles.tabCurrent)}
            >
              <Icon icon={item.icon} size={22} />
              <span>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
