// Loading, empty, error and status states, DESIGN_SPEC §5.3.
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../internal/cx";
import { Icon } from "../internal/Icon";
import shared from "../internal/shared.module.css";
import styles from "./states.module.css";

export interface EmptyStateProps {
  /** One sentence about what will appear and how. */
  children: ReactNode;
  /** An optional single action under the sentence. */
  action?: ReactNode;
  className?: string;
}

/** A dashed border.strong box, radius xl, centered muted text. */
export function EmptyState({ children, action, className }: EmptyStateProps) {
  return (
    <div className={cx(styles.empty, className)}>
      <p className={styles.emptyText}>{children}</p>
      {action}
    </div>
  );
}

export interface SkeletonProps {
  /** Any CSS length; match the final layout. */
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  /** Text-line skeletons are short; use `block` for tiles and charts. */
  shape?: "line" | "block";
  className?: string;
}

/** A bg.track skeleton block (radius xs). Decorative. */
export function Skeleton({ width = "100%", height, shape = "line", className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.skeleton, shape === "block" && styles.block, className)}
      style={{ width, height }}
    />
  );
}

export interface LoadingProps {
  /** What is loading, for screen readers: "Loading bills". */
  label: string;
  /** Skeleton blocks shaped like the final layout. */
  children: ReactNode;
  /** Skeletons show only after 300 ms (§5.3). */
  delayMs?: number;
  className?: string;
}

/** Shows its skeletons after `delayMs`, with a polite status for screen readers. No spinners. */
export function Loading({ label, children, delayMs = 300, className }: LoadingProps) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return (
    <div role="status" aria-busy="true" className={cx(styles.loading, className)}>
      {visible && (
        <>
          <span className={shared.visuallyHidden}>{label}</span>
          {children}
        </>
      )}
    </div>
  );
}

export interface ErrorBannerProps {
  /** What failed: "We couldn’t reach Gmail." */
  title: string;
  /** What still works: "Your plan still shows what we found earlier." */
  children?: ReactNode;
  /** The one retry action. */
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}

/** An attention card with role="alert". Never discard what the user entered. */
export function ErrorBanner({
  title,
  children,
  retryLabel = "Try again",
  onRetry,
  className,
}: ErrorBannerProps) {
  return (
    <div role="alert" className={cx(styles.error, className)}>
      <Icon icon={TriangleAlert} size={16} className={styles.errorIcon} />
      <p className={styles.errorText}>
        <strong>{title}</strong> {children}{" "}
        {onRetry && (
          <button type="button" className={styles.retry} onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </p>
    </div>
  );
}

export interface StatusBannerProps {
  /** What changed: "Electricity set to $151.37. Safe to spend is now $998." */
  children: ReactNode;
  /** e.g. an Undo button. */
  action?: ReactNode;
  className?: string;
}

/** A brand.soft banner with a check icon and role="status" (review queue, AI result). */
export function StatusBanner({ children, action, className }: StatusBannerProps) {
  return (
    <div role="status" className={cx(styles.status, className)}>
      <Icon icon={Check} size={16} className={styles.statusIcon} />
      <p className={styles.statusText}>{children}</p>
      {action}
    </div>
  );
}
